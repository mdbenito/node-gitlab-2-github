import settings from '../settings';
import { GithubSettings } from './settings';
import * as utils from './utils';
import { SimpleItem } from './utils';
import { Octokit as GitHubApi, RestEndpointMethodTypes } from '@octokit/rest';
import { Endpoints, RequestError } from '@octokit/types';
import { throttling } from '@octokit/plugin-throttling';

export interface GitHubIssueData {
  title: string;
  body: string;
  milestone?: number;
  labels: string[];
  created_at?: string;
  updated_at?: string;
  assignee?: string;
  assignees?: string[];
  state: 'open' | 'closed';
  closed?: boolean;
}

export interface GitHubPullRequestData extends GitHubIssueData {
  head: string;
  base: string;
  draft?: boolean;
}

export type GitHubIssue = Pick<
  Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}']['response']['data'],
  'number' | 'title' | 'body' | 'assignees' | 'milestone' | 'labels' | 'state'
>;

type PullsListResponseData =
  Endpoints['GET /repos/{owner}/{repo}/pulls']['response']['data'];

// HACK: the types returned by GET on /pulls/ and GET on /pulls/{pull_number} do
// not match
export type GitHubPullRequest =
  | PullsListResponseData[0]
  | Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data'];

type GitHubRelease =
  RestEndpointMethodTypes['repos']['getReleaseByTag']['response']['data'];

type GitHubLabel =
  RestEndpointMethodTypes['issues']['createLabel']['response']['data'];

export interface GitHubCommentData {
  body: string;
  created_at?: string; // not accepted by issue API
}

export interface GitHubCommentImport {
  created_at?: string;
  body: string;
}

export interface GitHubMilestoneData {
  title: string;
  description: string;
  state?: 'open' | 'closed';
  due_on?: string;
}

export interface GitHubLabelData {
  name: string;
  color: string;
  description?: string;
}

export class GitHubHelper {
  githubApi: GitHubApi;
  githubUrl: string;
  githubOwner: string;
  githubToken: string;
  githubRepo: string;
  githubTimeout?: number;
  repoId?: number;
  delayInMs: number;
  useIssuesForAllMergeRequests: boolean;
  useIssueImportAPI: boolean;

  constructor(
    githubSettings: GithubSettings,
    useIssuesForAllMergeRequests: boolean
  ) {
    const MyOctokit = GitHubApi.plugin(throttling);
    this.githubApi = new MyOctokit({
      previews: githubSettings.useIssueImportAPI ? ['golden-comet'] : [],
      debug: false,
      baseUrl: githubSettings.apiUrl
        ? githubSettings.apiUrl
        : 'https://api.github.com',
      timeout: 5000,
      headers: {
        'user-agent': 'node-gitlab-2-github', // GitHub is happy with a unique user agent
        accept: 'application/vnd.github.v3+json',
      },
      auth: 'token ' + githubSettings.token,
      throttle: {
        onRateLimit: async (retryAfter: number, options: any) => {
          console.log(
            `Request quota exhausted for request ${options.method} ${options.url}`
          );
          await utils.sleep(60000);
          return true;
        },
        onAbuseLimit: async (retryAfter: number, options: any) => {
          console.log(
            `Abuse detected for request ${options.method} ${options.url}`
          );
          await utils.sleep(60000);
          return true;
        },
      },
    });
    this.githubUrl = githubSettings.baseUrl;
    this.githubOwner = githubSettings.owner;
    this.githubToken = githubSettings.token;
    this.githubRepo = githubSettings.repo;
    this.githubTimeout = githubSettings.timeout;
    this.useIssueImportAPI = githubSettings.useIssueImportAPI;
    this.delayInMs = 2000;
    this.useIssuesForAllMergeRequests = useIssuesForAllMergeRequests;
  }

  /*
   ******************************************************************************
   ******************************** GET METHODS *********************************
   ******************************************************************************
   */

  /**
   * Store the new repo id
   */
  async registerRepoId() {
    await utils
      .sleep(this.delayInMs)
      .then(() =>
        this.githubApi.repos.get({
          owner: this.githubOwner,
          repo: this.githubRepo,
        })
      )
      .then(result => {
        this.repoId = result.data.id;
        console.log(`Registered repo id ${result.data.id}`);
      })
      .catch(err => {
        console.error(`Could not access GitHub repository: ${err}`);
        throw err;
      });
  }

  // ----------------------------------------------------------------------------

  /**
   * Get a list of all GitHub milestones currently in new repo
   */
  async getAllMilestones(): Promise<SimpleItem[]> {
    return await utils
      .sleep(this.delayInMs)
      .then(() =>
        this.githubApi.issues.listMilestones({
          owner: this.githubOwner,
          repo: this.githubRepo,
          state: 'all',
        })
      )
      .then(result =>
        result.data.map(x => ({
          iid: x.number,
          title: x.title,
          state: x.state,
          description: x.description || undefined,
        }))
      )
      .catch(err => {
        console.error('Could not retrieve GitHub milestones');
        console.error(err);
        return [];
      });
  }

  // ----------------------------------------------------------------------------

  /**
   * Get a list of all the current GitHub issues.
   * This uses a while loop to make sure that each page of issues is received.
   */
  async getAllIssues(): Promise<GitHubIssue[]> {
    let allIssues: GitHubIssue[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      // get a paginated list of issues
      let issues = await utils.sleep(this.delayInMs).then(() =>
        this.githubApi.issues.listForRepo({
          owner: this.githubOwner,
          repo: this.githubRepo,
          state: 'all',
          per_page: perPage,
          page: page,
        })
      );

      // if this page has zero issues then we are done!
      if (issues.data.length === 0) break;

      // join this list of issues with the master list
      allIssues = allIssues.concat(issues.data);

      // if there are strictly less issues on this page than the maximum number per page
      // then we can be sure that this is all the issues. No use querying again.
      if (issues.data.length < perPage) break;

      // query for the next page of issues next iteration
      page++;
    }

    return allIssues;
  }

  // ----------------------------------------------------------------------------

  /**
   * Get a list of all GitHub label names currently in new repo
   */
  async getAllLabelNames(): Promise<string[]> {
    type LabelsResponse =
      Endpoints['GET /repos/{owner}/{repo}/labels']['response'];

    return await utils
      .sleep(this.delayInMs)
      .then(() =>
        this.githubApi.issues.listLabelsForRepo({
          owner: this.githubOwner,
          repo: this.githubRepo,
        })
      )
      .then((result: LabelsResponse) => result.data.map(x => x.name))
      .catch(err => {
        console.error('Could not access all GitHub label names');
        console.error(err);
        return [];
      });
  }

  // ----------------------------------------------------------------------------

  /**
   * Gets a release by tag name
   * @param tag {string} - the tag name to search a release for
   * @returns
   */
  async getReleaseByTag(tag: string): Promise<GitHubRelease | null> {
    return await utils
      .sleep(this.delayInMs)
      .then(() =>
        this.githubApi.repos.getReleaseByTag({
          owner: this.githubOwner,
          repo: this.githubRepo,
          tag: tag,
        })
      )
      .then(response => response.data)
      .catch(err => {
        console.error(`Could not retrieve release ${tag}: ${err}`);
        return null;
      });
  }

  // ----------------------------------------------------------------------------

  /**
   * Get a list of all the current GitHub pull requests.
   * This uses a while loop to make sure that each page of issues is received.
   */
  async getAllPullRequests(): Promise<GitHubPullRequest[]> {
    let allPullRequests: PullsListResponseData = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      await utils.sleep(this.delayInMs);
      // get a paginated list of pull requests
      const pullRequests = await this.githubApi.pulls.list({
        owner: this.githubOwner,
        repo: this.githubRepo,
        state: 'all',
        per_page: perPage,
        page: page,
      });

      // if this page has zero PRs then we are done!
      if (pullRequests.data.length === 0) break;

      // join this list of PRs with the master list
      allPullRequests = allPullRequests.concat(pullRequests.data);

      // if there are strictly less PRs on this page than the maximum number per page
      // then we can be sure that this is all the PRs. No use querying again.
      if (pullRequests.data.length < perPage) break;

      // query for the next page of PRs next iteration
      page++;
    }

    return allPullRequests;
  }

  // ----------------------------------------------------------------------------

  /*
   ******************************************************************************
   ******************************** POST METHODS ********************************
   ******************************************************************************
   */

  /**
   * Update the description of the repository on GitHub.
   * Replaces newlines and tabs with spaces. No attempt is made to remove e.g. Markdown
   * links or other special formatting.
   */
  async updateRepositoryDescription(description: string) {
    let props: RestEndpointMethodTypes['repos']['update']['parameters'] = {
      owner: this.githubOwner,
      repo: this.githubRepo,
      description: description.replace(/\s+/g, ' '),
    };
    return this.githubApi.repos.update(props);
  }

  // ----------------------------------------------------------------------------

  /**
   * Creates a new release on github
   * @param tag_name {string} - the tag name
   * @param name {string} - title of the release
   * @param body {string} - description for the release
   */
  async createRelease(tag_name: string, name: string, body: string) {
    try {
      await utils.sleep(this.delayInMs);
      // get an array of GitHub labels for the new repo
      let result = await this.githubApi.repos.createRelease({
        owner: this.githubOwner,
        repo: this.githubRepo,
        tag_name,
        name,
        body,
      });

      return result;
    } catch (err) {
      console.error('Could not create release on github');
      console.error(err);
      return null;
    }
  }

  // ----------------------------------------------------------------------------

  /**
   * TODO description
   * @param milestones All GitHub milestones
   * @param issue The GitLab issue object
   */
  async createIssue(issue: GitHubIssueData): Promise<GitHubIssue> {
    let props: RestEndpointMethodTypes['issues']['create']['parameters'] = {
      owner: this.githubOwner,
      repo: this.githubRepo,
      ...issue,
    };

    return utils
      .sleep(this.delayInMs)
      .then(() => this.githubApi.issues.create(props))
      .then(response => response.data)
      .catch(err => {
        console.log(`Could not create issue ${issue.title}`);
        throw err;
      });
  }

  /**
   * Uses the preview issue import API to create an issue.
   *
   * This API allows setting creation date on issues and comments, and does not
   * notify assignees.
   *
   * See https://gist.github.com/jonmagic/5282384165e0f86ef105
   *
   * @param issue The GitLab issue object
   * @param comments The GitLab notes (comments, state changes) for the issue
   */
  async importIssueAndComments(
    issue: GitHubIssueData,
    comments: GitHubCommentImport[]
  ) {
    if (settings.debug) return Promise.resolve(issue);

    return this.requestImportIssue(
      { closed: issue.state === 'closed', ...issue },
      comments
    ).then(issue_number => {
      if (issue.assignees && issue.assignees.length > 1) {
        if (issue.assignees.length > 10) {
          console.error(
            `Cannot add more than 10 assignees to GitHub issue #${issue_number}.`
          );
        } else {
          console.log(
            `Importing ${issue.assignees.length} assignees for GitHub issue #${issue_number}`
          );
        }
        this.githubApi.issues.addAssignees({
          owner: this.githubOwner,
          repo: this.githubRepo,
          issue_number: issue_number,
          assignees: issue.assignees,
        });
      }
    });
  }

  /**
   * Calls the preview API for issue importing
   * See https://gist.github.com/jonmagic/5282384165e0f86ef105
   * @param issue Props for the issue
   * @param comments Comments
   * @returns GitHub issue number
   */
  async requestImportIssue(
    issue: GitHubIssueData,
    comments: GitHubCommentImport[]
  ): Promise<number> {
    // create the GitHub issue from the GitLab issue
    let pending = await this.githubApi.request(
      `POST /repos/${this.githubOwner}/${this.githubRepo}/import/issues`,
      {
        issue: utils.pick(
          issue,
          'title',
          'body',
          'milestone',
          'labels',
          'created_at',
          'updated_at',
          'assignee',
          'closed'
        ),
        comments: comments,
      }
    );

    let backoff = this.delayInMs;
    const maxRetries = 5;
    let request = async () =>
      utils
        .sleep(backoff)
        .then(() =>
          this.githubApi.request(
            `GET /repos/${this.githubOwner}/${this.githubRepo}/import/issues/${pending.data.id}`
          )
        )
        .then(response => {
          switch (response.data.status) {
            case 'imported':
              let issue_number = response.data.issue_url
                .split('/')
                .splice(-1)[0];
              return issue_number;
            case 'failed':
              console.error('\tFAILED:');
              console.error(response);
              console.error('\tERRORS:');
              console.error(response.data.errors);
              throw new Error(
                `Failed issue import with ${response.data.errors}`
              );
            default:
              backoff *= 1.5;
              if (backoff / this.delayInMs > 1.5 ** maxRetries) {
                throw new Error(
                  `No response after ${maxRetries} retries, querying status of import request for '${issue.title}'`
                );
              }
              console.log(`\tBacking off for ${backoff} ms`);
              request();
          }
        });
    return request();
  }

  // ----------------------------------------------------------------------------

  /**
   * TODO description
   *
   * @returns The same issue passed as argument (for convenience when chaining)
   */
  async createComments(
    item: GitHubIssue | GitHubPullRequest,
    comments: GitHubCommentData[]
  ): Promise<typeof item> {
    console.log('\tMigrating comments...');

    let nrOfMigratedNotes = 0;
    for (let comment of comments) {
      await this.createComment(item.number, comment).then(
        wasMigrated => (nrOfMigratedNotes += wasMigrated ? 1 : 0)
      );
    }

    if (comments.length === 0) {
      console.log(`\t...no issue comments available, nothing to migrate.`);
    } else {
      console.log(
        `\t...Done creating comments (migrated ${nrOfMigratedNotes} out of ${
          comments.length
        }, skipped ${comments.length - nrOfMigratedNotes})`
      );
    }
    return item;
  }

  // ----------------------------------------------------------------------------

  /*
   * Adds a comment to an issue
   */
  async createComment(
    issue_number: number,
    comment: GitHubCommentData
  ): Promise<boolean> {
    if (settings.debug) return true;

    return utils
      .sleep(this.delayInMs)
      .then(() => {
        this.githubApi.issues.createComment({
          owner: this.githubOwner,
          repo: this.githubRepo,
          issue_number: issue_number,
          body: comment.body,
        });
        return true;
      })
      .catch(err => {
        console.error(
          `Could not create comment for GitHub issue #${issue_number}:\n${err}`
        );
        return false;
      });
  }

  // ----------------------------------------------------------------------------

  /**
   * Update the issue state (i.e., closed or open).
   */
  async updateIssueState(githubIssue: GitHubIssue, state: 'open' | 'closed') {
    // default state is open so we don't have to update if the issue is closed.
    if (state.toLowerCase() !== 'closed' || githubIssue.state === 'closed')
      return;

    let props: RestEndpointMethodTypes['issues']['update']['parameters'] = {
      owner: this.githubOwner,
      repo: this.githubRepo,
      issue_number: githubIssue.number,
      state: state,
    };

    if (settings.debug) return Promise.resolve();

    return utils
      .sleep(this.delayInMs)
      .then(() => this.githubApi.issues.update(props));
  }

  // ----------------------------------------------------------------------------

  /**
   * Create a GitHub milestone from a GitLab milestone
   * @param milestone GitLab milestone data
   * @return Created milestone data (or void if debugging => nothing created)
   */
  async createMilestone(milestone: GitHubMilestoneData): Promise<SimpleItem> {
    let params: RestEndpointMethodTypes['issues']['createMilestone']['parameters'] =
      {
        owner: this.githubOwner,
        repo: this.githubRepo,
        ...milestone,
      };

    if (settings.debug) return Promise.resolve({ iid: -1, title: 'DEBUG' });

    return await utils
      .sleep(this.delayInMs)
      .then(() => this.githubApi.issues.createMilestone(params))
      .then(response => {
        return { iid: response.data.number, title: response.data.title };
      })
      .catch(err => {
        console.error(
          `Could not create milestone '${milestone.title}': ${err}`
        );
        throw err;
      });
  }

  // ----------------------------------------------------------------------------

  /**
   * Create a GitHub label
   */
  async createLabel(label: GitHubLabelData): Promise<GitHubLabel> {
    let params = {
      owner: this.githubOwner,
      repo: this.githubRepo,
      ...label,
    };

    return await utils
      .sleep(this.delayInMs)
      .then(() => this.githubApi.issues.createLabel(params))
      .then(response => response.data)
      .catch(err => {
        console.error(`Could not create label ${label.name}: ${err}`);
        throw err;
      });
  }

  // ----------------------------------------------------------------------------

  /**
   * Check to see if the target branch exists in GitHub - if it does not exist,
   * we cannot create a pull request
   *
   * @param branch
   * @param gitlabBranchNames
   * @returns True if the branch exists in GitHub, false if it doesn't and it also
   *          isn't among gitlabBranchNames (e.g. because it was deleted)
   * @throws Error if the branch does not exist in GitHub, but is among
   *         gitlabBranchNames (must be pushed to the GH repo)
   */
  async checkBranch(
    branch: string,
    gitlabBranchNames: string[]
  ): Promise<boolean> {
    return this.githubApi.repos
      .getBranch({
        owner: this.githubOwner,
        repo: this.githubRepo,
        branch: branch,
      })
      .then(response => true)
      .catch(err => {
        if (gitlabBranchNames.includes(branch)) {
          // Need to move that branch over to GitHub!
          console.error(
            `The branch '${branch}' exists on GitLab but has not been migrated to GitHub.`
          );
          throw new Error(`Must migrate branch ${branch} before migrating`);
        } else {
          console.error(
            `The branch '${branch}' no longer exists => cannot migrate merge request, creating an issue instead.`
          );
          return false;
        }
      });
  }

  /**
   * Create a pull request. A pull request can only be created if both the target and
   * source branches exist on the GitHub repository. In many cases, the source branch
   * is deleted when the merge occurs, and the merge request may not be able to be
   * migrated. In this case, we return false so that an issue can be created
   *
   * @param prData the data for the pull request
   * @param comments
   * @param gitlabBranchNames
   *
   * @returns
   */
  async createPullRequest(
    prData: GitHubPullRequestData,
    comments: GitHubCommentData[],
    gitlabBranchNames: string[]
    // FIXME return type of updateIssueState
  ): Promise<GitHubPullRequest | boolean | any> {
    let canCreate = !this.useIssuesForAllMergeRequests;
    // Check if both branches exist
    if (canCreate) {
      canCreate = await this.checkBranch(prData.base, gitlabBranchNames).then(
        branchExists =>
          branchExists && this.checkBranch(prData.head, gitlabBranchNames)
      );
    }
    if (settings.debug) return true;
    if (!canCreate) return false;

    // GitHub API Documentation to create a pull request:
    // https://developer.github.com/v3/pulls/#create-a-pull-request
    let props = {
      owner: this.githubOwner,
      repo: this.githubRepo,
      ...utils.pick(prData, 'head', 'base', 'body', 'draft', 'title'),
    };

    return utils
      .sleep(this.delayInMs)
      .then(() => this.githubApi.pulls.create(props))
      .then(response => this.createComments(response.data, comments))
      .then(issue => this.updateIssueData(issue.number, prData))
      .catch(err => {
        if ((err as RequestError).status === 422) {
          console.log(
            `Pull request '${prData.title}' - attempt to create has failed, probably '${prData.head}' has already been merged => cannot migrate pull request, creating an issue instead.`
          );
          return this.createIssueForPullRequest(prData, comments);
        } else {
          throw err;
        }
      });
  }

  async createIssueForPullRequest(
    prData: GitHubPullRequestData,
    comments: GitHubCommentData[]
  ): Promise<number> {
    // Failing all else, create an issue with a descriptive title

    let mergeStr = `_Merges ${prData.head} -> ${prData.base}_\n\n`;
    let props: any = {
      title: prData.title.trim() + ` - [${prData.state}]`,
      body: mergeStr + prData.body,
      labels: (prData.labels ?? []).concat(['gitlab merge request']),
    };

    console.log('\tCreating issue for PR...');
    if (this.useIssueImportAPI) {
      props = {
        ...props,
        ...utils.pick(
          prData,
          'assignee',
          'created_at',
          'updated_at',
          'milestone',
          'closed'
        ),
      };

      return this.requestImportIssue(props, comments).then(issue_number => {
        console.log('done');
        return issue_number;
      });
    } else {
      props = {
        owner: this.githubOwner,
        repo: this.githubRepo,
        ...props,
        ...utils.pick(prData, 'assignee', 'assignees', 'milestone'),
      };

      return this.githubApi.issues
        .create(props)
        .then(r => r.data.number)
        .then(issueNumber => this.updateIssueData(issueNumber, prData))
        .then(issue => {
          console.log('done');
          return issue.number;
        });
    }
  }

  // ----------------------------------------------------------------------------

  /**
   * Update the pull request data. The GitHub Pull Request API does not supply
   * methods to set the milestone, assignee, or labels; these data are set via
   * the Issues API in this function
   *
   * @param issueNumber the GitHub issue / PR number
   * @param issueData the data for the issue / PR
   */
  async updateIssueData(
    issueNumber: number,
    issueData: GitHubPullRequestData | GitHubIssueData
  ): Promise<GitHubIssue> {
    let props: RestEndpointMethodTypes['issues']['update']['parameters'] = {
      owner: this.githubOwner,
      repo: this.githubRepo,
      issue_number: issueNumber,
      ...utils.pick(issueData, 'milestone', 'assignee', 'labels', 'state'),
    };

    return utils
      .sleep(this.delayInMs)
      .then(() => this.githubApi.issues.update(props))
      .then(response => response.data);
  }

  // ----------------------------------------------------------------------------

  /**
   * Creates an issue and its comments.
   *
   * This method chooses between the standard issue data or the import API depending
   * on settings.
   *
   * @param issue Converted issue data
   * @param comments Converted comment data
   */
  async createIssueAndComments(
    issue: GitHubIssueData,
    comments: GitHubCommentData[]
  ) {
    if (this.useIssueImportAPI) {
      return this.importIssueAndComments(issue, comments);
    } else {
      return this.createIssue(issue)
        .then(githubIssue => this.createComments(githubIssue, comments))
        .then(githubIssue =>
          // update all data (milestone, labels, etc.) and
          // make sure to close the GitHub issue if it is closed in GitLab
          this.updateIssueData(githubIssue.number, issue)
        );
    }
  }

  // ----------------------------------------------------------------------------

  /**
   * Deletes the GH repository, then creates it again.
   */
  async recreateRepo() {
    let params = {
      owner: this.githubOwner,
      repo: this.githubRepo,
    };

    console.log(`Deleting repo ${params.owner}/${params.repo}...`);
    await this.githubApi.repos
      .delete(params)
      .then(_ => console.log('\t...done.'))
      .then(() => utils.sleep(this.delayInMs))
      .catch(err => {
        if ((err as RequestError).status == 404) {
          console.log('Repository not found. Creating...');
        } else {
          console.error(`\n\tSomething went wrong: ${err}.`);
          throw err;
        }
      })
      .then(() => {
        console.log(`\tCreating repo ${params.owner}/${params.repo}...`);
        return this.githubApi.repos.createForAuthenticatedUser({
          name: this.githubRepo,
          private: true,
        });
      })
      .then(_ => {
        console.log('\t...done.');
        return utils.sleep(this.delayInMs);
      });
  }
}
