import _ from 'lodash'
import path from 'path'
import readDir from 'recursive-readdir'

import type {S3} from 'aws-sdk'

export interface File {
  path: string
  name: string
}

export const UPLOAD_IGNORES = [
  '.DS_Store'
]

export const DEFAULT_UPLOAD_OPTIONS: Pick<S3.PutObjectRequest, 'ACL'> = {
  ACL: 'public-read'
}

export const REQUIRED_S3_UP_OPTS: (keyof S3.PutObjectRequest)[] = ['Bucket']
export const PATH_SEP = path.sep
export const S3_PATH_SEP = '/'
export const DEFAULT_TRANSFORM = (item: string) => Promise.resolve(item)

export const addTrailingS3Sep = (fPath: string) => {
  return fPath ? fPath.replace(/\/?(\?|#|$)/, '/$1') : fPath
}

export const addSeperatorToPath = (fPath: string) => {
  if (!fPath)
    return fPath

  return _.endsWith(fPath, PATH_SEP) ? fPath : fPath + PATH_SEP
}

export const translatePathFromFiles = (rootPath: string) => {
  return (files: string[]): File[] => {
    return _.map(files, file => {
      return {
        path: file,
        name: file
          .replace(rootPath, '')
          .split(PATH_SEP)
          .join(S3_PATH_SEP)
      }
    })
  }
}

export const getDirectoryFilesRecursive = (dir: string, ignores = []) => {
  return new Promise<string[]>((resolve, reject) => {
    readDir(dir, ignores, (err, files) => err ? reject(err) : resolve(files))
  })
    .then(translatePathFromFiles(dir))
}

export type Rule = string | RegExp | ((input: string) => boolean)

export const testRule = (rule: Rule | Rule[], subject: string): boolean => {
  if (rule instanceof RegExp) {
    return rule.test(subject)
  } else if (rule instanceof Function) {
    return !!rule(subject)
  } else if (rule instanceof Array) {
    return rule.every((condition) => testRule(condition, subject))
  } else if (typeof rule === 'string') {
    return new RegExp(rule).test(subject)
  } else {
    throw new Error('Invalid include / exclude rule')
  }
}
