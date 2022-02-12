import { S3Settings } from './settings';
import { GitLabHelper } from './gitlabHelper';
import S3 from 'aws-sdk/clients/s3';
import AWS from 'aws-sdk';
import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';

export interface AttachmentMetadata {
  origin: string;
  destination: string;
  mimeType?: string;
}

export interface StorageHelper {
  preprocessAttachment(url: string): AttachmentMetadata;
  migrateAttachment(data: AttachmentMetadata): void;
}

/**
 * A dummy StorageHelper which simply rewrites links to attachments
 * to point to the original source in GitLab
 */
export class PassThroughStorageHelper implements StorageHelper {
  host: string;
  gitlabHelper: GitLabHelper;

  constructor(gitlabHelper: GitLabHelper, prefix?: string) {
    this.gitlabHelper = gitlabHelper;
    this.host = this.gitlabHelper.host.endsWith('/')
      ? this.gitlabHelper.host
      : this.gitlabHelper.host + '/';
  }

  preprocessAttachment(url: string): AttachmentMetadata {
    const attachmentUrl = this.host + this.gitlabHelper.projectPath + url;
    return {
      origin: url,
      destination: attachmentUrl,
    };
  }

  migrateAttachment(data: AttachmentMetadata) {
    // noop
  }
}

/**
 * FIXME: make the backend configurable, probably subclassing
 * Doesn't seem like it is easy to upload an issue to github, so upload to S3
 * https://stackoverflow.com/questions/41581151/how-to-upload-an-image-to-use-in-issue-comments-via-github-api

 */
export class S3Helper implements StorageHelper {
  gitlabHelper: GitLabHelper;
  s3: S3;
  bucket: string;
  prefix?: string;

  constructor(
    gitlabHelper: GitLabHelper,
    s3settings: S3Settings,
    prefix?: string
  ) {
    this.gitlabHelper = gitlabHelper;

    AWS.config.credentials = new AWS.Credentials({
      accessKeyId: s3settings.accessKeyId,
      secretAccessKey: s3settings.secretAccessKey,
    });
    this.s3 = new S3();
    this.prefix = prefix;
    this.bucket = s3settings.bucket;
  }

  /**
   *
   * @param url URL of the attachment
   * @param prefix Prefix to use in the destination
   * @returns
   */
  preprocessAttachment(url: string): AttachmentMetadata {
    const basename = path.basename(url);
    const mimeType = mime.lookup(basename) || undefined;

    // // Generate file name for S3 bucket from URL
    const hash = crypto.createHash('sha256');
    hash.update(url);
    const newFileName = hash.digest('hex') + '/' + basename;
    const relativePath = this.prefix
      ? `${this.prefix}/${newFileName}`
      : newFileName;

    const s3url = `https://${this.bucket}.s3.amazonaws.com/${relativePath}`;

    return {
      origin: url,
      destination: s3url,
      mimeType: mimeType || undefined,
    };
  }

  /**
   *
   * @param attachment
   */
  async migrateAttachment(attachment: AttachmentMetadata) {
    console.log(`Migrating ${attachment.origin}:\n\tDownloading...`);
    this.gitlabHelper
      .getAttachment(attachment.origin)
      .then(buffer => {
        const params: S3.PutObjectRequest = {
          Key: attachment.destination,
          Body: buffer,
          ContentType: attachment.mimeType,
          Bucket: this.bucket,
        };
        console.log(`\tUploading to ${attachment.destination}... `);
        return this.s3.upload(params).promise();
      })
      .then(_ => console.log(`\t...Done uploading`))
      .catch(err => console.error(err));
  }
}
