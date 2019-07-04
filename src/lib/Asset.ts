import * as fs from 'fs-extra'
import * as path from 'path'
import * as mime from 'mime/lite'

import { Log } from 'decentraland-commons'
import * as gltfPipeline from 'gltf-pipeline'

import { CIDUtils } from './CIDUtils'
import { getSHA256 } from './crypto'
import { getFiles, getRelativeDir } from './files'
import { checkFile, uploadFile } from './s3'
import {
  AssetSchema,
  File,
  validateObject,
  TYPE_NAMES
} from 'nft-open-api/dist'
import { AssetPack } from './AssetPack'

const ASSET_RESOURCE_FORMATS = ['.glb', '.gltf', '.png', '.jpg', '.bin']
const ASSET_SCENE_FORMATS = ['.glb']
const ASSET_FILE_NAME = 'asset.json'
const THUMB_FILE_NAME = 'thumbnail.png'

const log = new Log('Asset')

export class Asset {
  id: string
  name: string
  category: string
  tags: string[]
  thumbnail: string = ''
  url: string = ''
  variations: string[] = []
  contents: Record<string, string> = {}
  directory: string = ''

  constructor(
    directory: string,
    name: string,
    category: string,
    tags: string[],
    public assetPack: AssetPack
  ) {
    this.id = getSHA256(path.basename(directory))
    this.directory = directory
    this.name = name
    this.category = category
    this.tags = tags

    this.check()
  }

  static async build(assetDir: string, assetPack: AssetPack): Promise<Asset> {
    log.info(`Reading : ${assetDir}...`)

    const filepath = path.join(assetDir, ASSET_FILE_NAME)
    const assetData = await fs.readFile(filepath)
    const assetJSON = JSON.parse(assetData.toString())

    return new Asset(
      assetDir,
      assetJSON.name,
      assetJSON.category,
      assetJSON.tags,
      assetPack
    )
  }

  check() {
    if (!this.name) {
      throw new Error(`Asset must have a name`)
    }

    if (this.tags.length === 0) {
      throw new Error(`Asset must have at least 1 tag`)
    }

    if (!this.category) {
      throw new Error(`Asset must have a category`)
    }

    // TODO: Is this check necessary?
    // if (this.tags.indexOf(this.category) === -1) {
    //   throw new Error(`Asset must have a category from the included tags`)
    // }
  }

  async fill(): Promise<Asset> {
    // Thumb
    const thumbnailPath = path.join(this.directory, THUMB_FILE_NAME)
    const { cid } = await new CIDUtils(thumbnailPath).getFilePathCID()
    this.thumbnail = this.assetPack.contentServerURL + '/' + cid

    // Textures
    await this.saveContentTextures()

    // Content
    const contentFilePaths = this.getResources()
    const fileCIDs: Promise<void>[] = []
    for (const contentFilePath of contentFilePaths) {
      const fileCID = new CIDUtils(contentFilePath)
        .getFilePathCID()
        .then(({ cid }) => {
          this.contents[getRelativeDir(contentFilePath)] = cid
        })

      fileCIDs.push(fileCID)
    }
    await Promise.all(fileCIDs)

    // Entry point
    const sceneFilePath = Object.keys(this.contents).find(isAssetScene) || ''
    this.url = sceneFilePath

    return this
  }

  async saveContentTextures() {
    const contentFilePaths = this.getScenes()

    for (const contentFilePath of contentFilePaths) {
      try {
        await saveTexturesFromGLB(contentFilePath, this.directory)
      } catch (err) {
        log.error(`Error trying to save textures from glb ${err.message}`)
      }
    }
  }

  getScenes() {
    return this.getFiles().filter(isAssetScene)
  }

  getResources() {
    return this.getFiles().filter(isAssetResource)
  }

  getFiles() {
    return getFiles(this.directory + '/')
  }

  async upload(bucketName: string, assetPackDir: string, skipCheck: boolean) {
    const uploads = Object.entries(this.contents).map(
      async ([contentFilePath, contentCID]) => {
        const isFileUploaded = skipCheck
          ? false
          : await checkFile(bucketName, contentCID)
        const contentType = mime.getType(contentFilePath)

        if (!isFileUploaded) {
          const contentFullPath = path.join(assetPackDir, contentFilePath)
          const contentData = await fs.readFile(contentFullPath)
          return uploadFile(bucketName, contentType, contentCID, contentData)
        }
      }
    )

    await Promise.all(uploads)
  }

  toJSON(): AssetSchema {
    const files: File[] = []

    for (let key in this.contents) {
      const cid = this.contents[key]
      files.push({
        name: key,
        cid,
        url: `${this.assetPack.contentServerURL}/${cid}`
      })
    }

    const ret: AssetSchema = {
      name: this.name,
      description: '',
      token_id: this.id,
      image: this.thumbnail,
      uri: this.assetPack.contractUri + '/' + this.id,
      files,
      owner: '',
      registry: this.assetPack.info.id!,
      traits: [
        { id: 'dcl:asset-pack:category', value: this.category },
        ...this.tags.map(value => ({ id: 'dcl:asset-pack:tag', value })),
        ...this.variations.map(value => ({
          id: 'dcl:asset-pack:variation',
          value
        }))
      ]
    }

    validateObject(TYPE_NAMES.AssetSchema, ret)

    return ret
  }
}

// Validation

const isAssetFormat = (formats: string[]) => {
  return function(source: string): boolean {
    const extension = path.extname(source)
    for (const format of formats) {
      if (extension.indexOf(format) !== -1) {
        return true
      }
    }
    return false
  }
}

const isAssetResource = isAssetFormat(ASSET_RESOURCE_FORMATS)
const isAssetScene = isAssetFormat(ASSET_SCENE_FORMATS)

// Save files

export async function saveTexturesFromGLB(
  srcFilePath: string,
  outDir: string = '.'
) {
  const options = {
    separateTextures: true
  }
  const data = await fs.readFile(srcFilePath)

  // TODO: npm install defenetly typed
  const results = await gltfPipeline.processGlb(data, options)
  const glbFilePath = path.join(outDir, path.basename(srcFilePath))
  const writeOperations: Promise<any>[] = []

  writeOperations.push(fs.writeFile(glbFilePath, results.glb))

  const separateResources = results.separateResources
  for (const relativePath in separateResources) {
    if (separateResources.hasOwnProperty(relativePath)) {
      const resource = separateResources[relativePath]
      const resourceFilePath = path.join(outDir, relativePath)
      writeOperations.push(fs.writeFile(resourceFilePath, resource))
    }
  }

  await Promise.all(writeOperations)
}
