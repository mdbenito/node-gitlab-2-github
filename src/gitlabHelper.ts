import { Gitlab } from '@gitbeaker/node';
import {
  BranchSchema,
  IssueSchema,
  MergeRequestSchema,
  MilestoneSchema,
  NoteSchema,
  UserSchema,
  DiscussionNotePosition,
  LabelSchema,
} from '@gitbeaker/core/dist/types/types';

import { GitlabSettings } from './settings';
import axios from 'axios';

export type GitLabIssue = IssueSchema;
export type GitLabNote = NoteSchema;
export type GitLabUser = Omit<UserSchema, 'created_at'>;
export type GitLabMilestone = MilestoneSchema;
export type GitLabMergeRequest = MergeRequestSchema;
export type GitLabBranch = BranchSchema;
export type GitLabPosition = DiscussionNotePosition;
export type GitLabLabel = LabelSchema;

export class GitLabHelper {
  // Wait for this issue to be resolved
  // https://github.com/jdalrymple/gitbeaker/issues/793
  private readonly gitlabApi: InstanceType<typeof Gitlab>;
  private readonly gitlabProjectId: number;
  private readonly sessionCookie: string;
  readonly host: string;
  projectPath?: string;

  private allBranches?: GitLabBranch[];
  private allMilestones?: GitLabMilestone[];
  private allIssues?: GitLabIssue[];
  private allMergeRequests?: MergeRequestSchema[];

  private readonly filterByLabel?: string;
  private readonly skipMergeRequestStates?: string[];
  private readonly skipMatchingComments?: string[];

  constructor(
    gitlabApi: InstanceType<typeof Gitlab>,
    gitlabSettings: GitlabSettings,
    filterByLabel?: string,
    skipMergeRequestStates?: string[],
    skipMatchingComments?: string[]
  ) {
    this.gitlabApi = gitlabApi;
    this.gitlabProjectId = gitlabSettings.projectId;
    this.host = gitlabSettings.url ? gitlabSettings.url : 'http://gitlab.com';
    this.host = this.host.endsWith('/')
      ? this.host.substring(0, this.host.length - 1)
      : this.host;
    this.sessionCookie = gitlabSettings.sessionCookie;
    this.filterByLabel = filterByLabel;
    this.skipMergeRequestStates = skipMergeRequestStates;
    this.skipMatchingComments = skipMatchingComments;
  }

  /**
   * List all projects that the GitLab user is associated with.
   */
  async listProjects() {
    try {
      const projects = await this.gitlabApi.Projects.all({ membership: true });

      // print each project with info
      for (let project of projects) {
        console.log(
          project.id.toString(),
          '\t',
          project.name,
          '\t--\t',
          project['description']
        );
      }

      // instructions for user
      console.log('\n\n');
      console.log(
        'Select which project ID should be transported to github. Edit the settings.js accordingly. (gitlab.projectID)'
      );
      console.log('\n\n');
    } catch (err) {
      console.error(`Could not fetch all GitLab projects: ${err}`);
      process.exit(1);
    }
  }

  /**
   * Stores project path in a field
   */
  async registerProjectPath() {
    await this.gitlabApi.Projects.show(this.gitlabProjectId)
      .then(project => (this.projectPath = project['path_with_namespace']))
      .catch(err => {
        console.error(
          `Could not fetch info for project ${this.gitlabProjectId}: ${err}`
        );
        throw err;
      });
  }

  /**
   * Gets all notes for a given issue.
   */
  async getIssueNotes(issueIid: number): Promise<GitLabNote[]> {
    return this.gitlabApi.IssueNotes.all(
      this.gitlabProjectId,
      issueIid,
      {}
    ).catch(err => {
      console.error(`Could not fetch notes for GitLab issue #${issueIid}.`);
      return [];
    });
  }

  /**
   * Gets attachment using http get
   */
  async getAttachment(relurl: string): Promise<Buffer | undefined> {
    const attachmentUrl = this.host + '/' + this.projectPath + relurl;
    return axios
      .get(attachmentUrl, {
        responseType: 'arraybuffer',
        headers: {
          // HACK: work around GitLab's API lack of GET for attachments
          // See https://gitlab.com/gitlab-org/gitlab/-/issues/24155
          Cookie: `_gitlab_session=${this.sessionCookie}`,
        },
      })
      .then(ret => Buffer.from(ret.data, 'binary'))
      .catch(err => {
        console.error(`Could not download attachment ${relurl}.`);
        throw new Error(`Error downloading '${relurl}': ${err}`);
      });
  }

  /**
   * @returns All branches for the current project (cached)
   */
  async getAllBranches(): Promise<GitLabBranch[]> {
    if (!this.allBranches) {
      this.allBranches = await this.gitlabApi.Branches.all(
        this.gitlabProjectId
      ).catch(err => {
        console.log(
          `Could not fetch branches for project ${this.gitlabProjectId}: ${err}`
        );
        return [];
      });
    }
    return this.allBranches;
  }

  /**
   *
   * @returns All milestones for the current project (cached)
   */
  async getAllMilestones(): Promise<GitLabMilestone[]> {
    if (!this.allMilestones) {
      this.allMilestones = await this.gitlabApi.ProjectMilestones.all(
        this.gitlabProjectId
      ).catch(err => {
        console.log(
          `Could not fetch milestones for project ${this.gitlabProjectId}: ${err}`
        );
        return [];
      });
    }
    return this.allMilestones;
  }

  /**
   *
   * @returns All issues for the current project (cached)
   */
  async getAllIssues(): Promise<GitLabIssue[]> {
    if (!this.allIssues) {
      // FIXME: Issues.all() returns Omit<IssueSchema, "epic">
      this.allIssues = (await this.gitlabApi.Issues.all({
        projectId: this.gitlabProjectId,
        labels: this.filterByLabel,
      }).catch(err => {
        console.log(
          `Could not fetch issues for project ${this.gitlabProjectId}: ${err}`
        );
        return [];
      })) as GitLabIssue[];
    }
    return this.allIssues;
  }

  /**
   *
   * @returns All merge requests for the current project (cached)
   */
  async getAllMergeRequests(): Promise<GitLabMergeRequest[]> {
    if (!this.allMergeRequests) {
      this.allMergeRequests = await this.gitlabApi.MergeRequests.all({
        projectId: this.gitlabProjectId,
        labels: this.filterByLabel,
      }).catch(err => {
        console.log(
          `Could not fetch merge requests for project ${this.gitlabProjectId}: ${err}`
        );
        return [];
      });
    }
    return this.allMergeRequests;
  }

  /**
   * @returns All notes for the given merge request.
   */
  async getAllMergeRequestNotes(mrId: number): Promise<GitLabNote[]> {
    return this.gitlabApi.MergeRequestNotes.all(
      this.gitlabProjectId,
      mrId,
      {}
    ).catch(err => {
      console.error(`Could not fetch notes for GitLab merge request #${mrId}.`);
      return [];
    });
  }
}
