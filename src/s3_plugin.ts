import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import ProgressBar from 'progress'
import cdnizer from 'cdnizer'
import _ from 'lodash'
import mime from 'mime/lite'
import {S3, CloudFront} from 'aws-sdk'

import type {Compilation, Compiler} from 'webpack'

import packageJson from '../package.json'

import {
  addSeperatorToPath,
  addTrailingS3Sep,
  getDirectoryFilesRecursive,
  testRule,
  UPLOAD_IGNORES,
  DEFAULT_UPLOAD_OPTIONS,
  REQUIRED_S3_UP_OPTS,
  PATH_SEP,
  DEFAULT_TRANSFORM,
  File,
  Rule,
} from './helpers'

http.globalAgent.maxSockets = https.globalAgent.maxSockets = 50

const compileError = (compilation: Compilation, error: string) => {
  compilation.errors.push(new Error(error))
}

interface CloudfrontInvalidateOptions {
  DistributionId: string | string[]
  Items: CloudFront.PathList
}

interface PluginOptions {
  directory?: string
  include?: Rule
  exclude?: Rule
  basePath: string
  priority?: RegExp[]
  htmlFiles?: string[]
  progress: boolean
}

type UploadOptions = S3.PutObjectRequest & Partial<Pick<S3.PutObjectRequest, 'Key' | 'Body'>>

export interface ConstructorOptions {
  include?: Rule
  exclude?: Rule
  progress?: boolean
  basePath?: string
  directory?: string
  htmlFiles?: string[]
  basePathTransform(item: string): Promise<string>
  s3Options: S3.ClientConfiguration
  cdnizerOptions: Record<string, unknown>
  s3UploadOptions: UploadOptions
  cloudfrontInvalidateOptions?: CloudfrontInvalidateOptions
  priority?: RegExp[]
}

class S3Plugin {
  isConnected = false
  urlMappings = []
  uploadTotal = 0
  uploadProgress = 0

  uploadOptions: UploadOptions
  cloudfrontInvalidateOptions?: CloudfrontInvalidateOptions
  basePathTransform: (item: string) => Promise<string>
  options: PluginOptions
  s3Options: S3.ClientConfiguration
  noCdnizer: boolean
  cdnizerOptions: any
  cdnizer: any
  client?: S3

  constructor(options: ConstructorOptions) {
    let {
      include,
      exclude,
      progress,
      basePath,
      directory,
      htmlFiles,
      basePathTransform = DEFAULT_TRANSFORM,
      s3Options = {},
      cdnizerOptions = {},
      s3UploadOptions,
      cloudfrontInvalidateOptions,
      priority,
    } = options

    this.uploadOptions = s3UploadOptions
    this.cloudfrontInvalidateOptions = cloudfrontInvalidateOptions
    this.cdnizerOptions = cdnizerOptions
    this.basePathTransform = basePathTransform
    basePath = basePath ? addTrailingS3Sep(basePath) : ''

    this.options = {
      directory,
      include,
      exclude,
      basePath,
      priority,
      htmlFiles: typeof htmlFiles === 'string' ? [htmlFiles] : htmlFiles,
      progress: _.isBoolean(progress) ? progress : true,
    }

    this.s3Options = s3Options

    this.noCdnizer = !Object.keys(this.cdnizerOptions).length

    if (!this.noCdnizer && !this.cdnizerOptions.files)
      this.cdnizerOptions.files = []
  }

  apply(compiler: Compiler) {
    this.connect()

    const isDirectoryUpload = !!this.options.directory,
          hasRequiredUploadOpts = _.every(
            REQUIRED_S3_UP_OPTS,
            (type) => this.uploadOptions[type]
          )

    // Set directory to output dir or custom
    this.options.directory =
      this.options.directory ||
      compiler.options.output.path ||
      compiler.options.output.context ||
      '.'

    compiler.hooks.done.tapPromise(
      packageJson.name,
      async({compilation}): Promise<void> => {
        let error: string

        if (!hasRequiredUploadOpts) {
          error = `S3Plugin-RequiredS3UploadOpts: ${REQUIRED_S3_UP_OPTS.join(
            ', '
          )}`

          compileError(compilation, error)

          return
        }

        if (isDirectoryUpload) {
          const dPath = addSeperatorToPath(this.options.directory)

          this.getAllFilesRecursive(dPath)
            .then((files) => this.handleFiles(files))
            .catch((e) => this.handleErrors(e, compilation))
        } else {
          this.getAssetFiles(compilation)
            .then((files) => this.handleFiles(files))
            .catch((e) => this.handleErrors(e, compilation))
        }
      }
    )
  }

  handleFiles(files: File[]) {
    return this.changeUrls(files)
      .then((files) => this.filterAllowedFiles(files))
      .then((files) => this.uploadFiles(files))
      .then(() => this.invalidateCloudfront())
  }

  async handleErrors(error: Error | string, compilation: Compilation) {
    compileError(compilation, `S3Plugin: ${error}`)
    throw error
  }

  getAllFilesRecursive(fPath: string) {
    return getDirectoryFilesRecursive(fPath)
  }

  addPathToFiles(files: string[], fPath: string): File[] {
    return files.map((file) => ({
      name: file,
      path: path.resolve(fPath, file),
    }))
  }

  getFileName(file = '') {
    if (_.includes(file, PATH_SEP))
      return file.substring(_.lastIndexOf(file, PATH_SEP) + 1)
    else return file
  }

  getAssetFiles({assets, outputOptions}: Compilation) {
    const files: File[] = _.map(assets, (value, name) => ({
      name,
      path: `${outputOptions.path}/${name}`,
    }))

    return Promise.resolve(files)
  }

  cdnizeHtml(file: File) {
    return new Promise<File>((resolve, reject) => {
      fs.readFile(file.path, (err, data) => {
        if (err) return reject(err)

        fs.writeFile(file.path, this.cdnizer(data.toString()), (err) => {
          if (err) return reject(err)

          resolve(file)
        })
      })
    })
  }

  changeUrls(files: File[] = []): Promise<File[]> {
    if (this.noCdnizer) return Promise.resolve(files)

    let allHtml: File[]

    const {directory, htmlFiles = []} = this.options

    if (htmlFiles.length)
      allHtml = this.addPathToFiles(htmlFiles, directory as string).concat(files)
    else allHtml = files

    this.cdnizerOptions.files = allHtml.map(({name}) => `{/,}*${name}*`)
    this.cdnizer = cdnizer(this.cdnizerOptions)

    const [cdnizeFiles, otherFiles] = _(allHtml)
      .uniq('name')
      .partition((file) => /\.(html|css)/.test(file.name))
      .value()

    return Promise.all(
      [...cdnizeFiles.map((file) => this.cdnizeHtml(file)), ...otherFiles]
    )
  }

  filterAllowedFiles(files: File[]) {
    return files.reduce<File[]>((res, file) => {
      if (
        this.isIncludeAndNotExclude(file.name) &&
        !this.isIgnoredFile(file.name)
      )
        res.push(file)

      return res
    }, [])
  }

  isIgnoredFile(file: string) {
    return _.some(UPLOAD_IGNORES, (ignore) => new RegExp(ignore).test(file))
  }

  isIncludeAndNotExclude(file: string) {
    let isExclude: boolean,
        isInclude: boolean
    const {include, exclude} = this.options

    isInclude = include ? testRule(include, file) : true
    isExclude = exclude ? testRule(exclude, file) : false

    return isInclude && !isExclude
  }

  connect() {
    if (this.isConnected) return

    this.client = new S3(this.s3Options)
    this.isConnected = true
  }

  transformBasePath() {
    return Promise.resolve<string>(this.basePathTransform(this.options.basePath))
      .then(addTrailingS3Sep)
      .then((nPath) => {this.options.basePath = nPath})
  }

  setupProgressBar(uploadFiles: S3.ManagedUpload[]) {
    const progressTotal = uploadFiles.reduce((acc, upload) => upload.totalBytes + acc, 0)

    const progressBar = new ProgressBar('Uploading [:bar] :percent :etas', {
      complete: '>',
      incomplete: '∆',
      total: progressTotal,
    })

    let progressValue = 0

    uploadFiles.forEach((upload) => {
      upload.on('httpUploadProgress', ({loaded}) => {
        progressValue += loaded

        progressBar.update(progressValue)
      })
    })
  }

  prioritizeFiles(files: File[]) {
    const {priority = []} = this.options
    const remainingFiles = [...files]
    const prioritizedFiles = priority.map((reg) =>
      _.remove(remainingFiles, (file: File) => reg.test(file.name))
    )

    return [remainingFiles, ...prioritizedFiles]
  }

  uploadPriorityChunk(priorityChunk: File[]) {
    const uploadFiles = priorityChunk.map((file) =>
      this.uploadFile(file.name, file.path)
    )

    return Promise.all(uploadFiles.map(({promise}) => promise))
  }

  uploadInPriorityOrder(files: File[]) {
    const priorityChunks = this.prioritizeFiles(files)
    const uploadFunctions = priorityChunks.map((priorityChunk) => () =>
      this.uploadPriorityChunk(priorityChunk)
    )

    return Promise.all(uploadFunctions.map(Promise.resolve))
  }

  uploadFiles(files: File[] = []): Promise<void> {
    return this.transformBasePath().then(() => {
      if (this.options.priority) {
        this.uploadInPriorityOrder(files)
      } else {
        const uploadFiles = files.map((file) =>
          this.uploadFile(file.name, file.path)
        )

        if (this.options.progress) {
          this.setupProgressBar(uploadFiles.map(({upload}) => upload))
        }

        Promise.all(uploadFiles)
      }
    })
  }

  uploadFile(fileName: string, file: string) {
    let Key = this.options.basePath + fileName
    const s3Params: UploadOptions = _.mapValues(this.uploadOptions, (optionConfig) => {
      return _.isFunction(optionConfig) ? optionConfig(fileName, file) : optionConfig
    })

    // avoid noname folders in bucket
    if (Key[0] === '/') Key = Key.substr(1)

    if (s3Params.ContentType === undefined) {
      const contentType = mime.getType(fileName)

      contentType && (s3Params.ContentType = contentType)
    }

    const Body = fs.createReadStream(file)

    const upload = this.client!.upload(
      _.merge({Key, Body}, DEFAULT_UPLOAD_OPTIONS, s3Params)
    )

    if (!this.noCdnizer) this.cdnizerOptions.files.push(`*${fileName}*`)

    return {upload, promise: upload.promise()}
  }

  invalidateCloudfront() {
    const {s3Options, cloudfrontInvalidateOptions} = this

    if (cloudfrontInvalidateOptions?.DistributionId) {
      const {
        accessKeyId,
        secretAccessKey,
        sessionToken,
      } = s3Options
      const cloudfront = new CloudFront({
        accessKeyId,
        secretAccessKey,
        sessionToken,
      })

      if (!(cloudfrontInvalidateOptions.DistributionId instanceof Array))
        cloudfrontInvalidateOptions.DistributionId = [
          cloudfrontInvalidateOptions.DistributionId
        ]

      const cloudfrontInvalidations = cloudfrontInvalidateOptions.DistributionId.map(
        (DistributionId) =>
          new Promise((resolve, reject) => {
            cloudfront.createInvalidation({
              DistributionId,
              InvalidationBatch: {
                CallerReference: Date.now().toString(),
                Paths: {
                  Quantity: cloudfrontInvalidateOptions.Items.length,
                  Items: cloudfrontInvalidateOptions.Items,
                },
              },
            }, (err, res) => {
              if (err) reject(err)
              else resolve(res.Id)
            })
          })
      )

      return Promise.all(cloudfrontInvalidations)
    } else {
      return Promise.resolve(null)
    }
  }
}

export default S3Plugin
