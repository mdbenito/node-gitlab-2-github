import { GitHubHelper, GitHubLabelData } from './githubHelper';
import {
  GitLabHelper,
  GitLabIssue,
  GitLabLabel,
  GitLabMergeRequest,
  GitLabMilestone,
} from './gitlabHelper';
import settings from '../settings';

import { Octokit as GitHubApi } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { Gitlab } from '@gitbeaker/node';

import { default as readlineSync } from 'readline-sync';
import * as fs from 'fs';

import AWS from 'aws-sdk';
import { SimpleItem, sleep } from './utils';
import { RepoConverter } from './repoConverter';
import {
  PassThroughStorageHelper,
  S3Helper,
  StorageHelper,
} from './storageHelper';

const counters = {
  nrOfPlaceholderIssues: 0,
  nrOfReplacementIssues: 0,
  nrOfFailedIssues: 0,
  nrOfFailedMilestones: 0,
  nrOfPlaceholderMilestones: 0,
  nrOfMigratedLabels: 0,
  nrOfFailedLabels: 0,
  nrOfMigratedMergeRequests: 0,
  nrOfFailedMergeRequests: 0,
};

// Ensure that the GitLab token has been set in settings.js
if (
  !settings.gitlab.token ||
  settings.gitlab.token === '{{gitlab private token}}'
) {
  console.log(
    '\n\nYou have to enter your GitLab private token in the settings.js file.'
  );
  process.exit(1);
}

// Create a GitLab API object
const gitlabApi = new Gitlab({
  host: settings.gitlab.url ? settings.gitlab.url : 'http://gitlab.com',
  token: settings.gitlab.token,
});

const MyOctokit = GitHubApi.plugin(throttling);

// Create a GitHub API object
const githubApi = new MyOctokit({
  previews: settings.github.useIssueImportAPI ? ['golden-comet'] : [],
  debug: false,
  baseUrl: settings.github.apiUrl
    ? settings.github.apiUrl
    : 'https://api.github.com',
  timeout: 5000,
  headers: {
    'user-agent': 'node-gitlab-2-github', // GitHub is happy with a unique user agent
    accept: 'application/vnd.github.v3+json',
  },
  auth: 'token ' + settings.github.token,
  throttle: {
    onRateLimit: async (retryAfter, options) => {
      console.log(
        `Request quota exhausted for request ${options.method} ${options.url}`
      );
      await sleep(60000);
      return true;
    },
    onAbuseLimit: async (retryAfter, options) => {
      console.log(
        `Abuse detected for request ${options.method} ${options.url}`
      );
      await sleep(60000);
      return true;
    },
  },
});

const gitlabHelper = new GitLabHelper(gitlabApi, settings.gitlab);
const githubHelper = new GitHubHelper(
  githubApi,
  settings.github,
  settings.useIssuesForAllMergeRequests
);

let storageHelper: StorageHelper;
if (settings.s3 && settings.s3.bucket) {
  storageHelper = new S3Helper(
    gitlabHelper,
    settings.s3,
    githubHelper.repoId?.toString()
  );
} else {
  storageHelper = new PassThroughStorageHelper(gitlabHelper);
}

const converter = new RepoConverter(gitlabHelper, githubHelper, storageHelper);

// If no project id is given in settings.js, just return
// all of the projects that this user is associated with.
if (!settings.gitlab.projectId) {
  gitlabHelper.listProjects();
} else {
  // user has chosen a project
  if (settings.github.recreateRepo === true) {
    recreate();
  }
  migrate();
}

// ----------------------------------------------------------------------------

/**
 * Asks for confirmation and maybe recreates the GitHub repository.
 */
async function recreate() {
  readlineSync.setDefaultOptions({
    limit: ['no', 'yes'],
    limitMessage: 'Please enter yes or no',
    defaultInput: 'no',
  });
  const ans = readlineSync.question('Delete and recreate? [yes/no] ');
  if (ans == 'yes') await githubHelper.recreateRepo();
  else console.log("OK, I won't delete anything then.");
}

// ----------------------------------------------------------------------------

/**
 * Sequentially performs all of the migration tasks to move a GitLab repo to
 * GitHub
 */
async function migrate() {
  await gitlabHelper
    .registerProjectPath()
    .then(_ => githubHelper.registerRepoId())
    .catch(err => {
      console.error(err);
      process.exit(1);
    });

  // Always download all data to build the GitLab->GitHub maps required to
  // convert references in comments

  await converter
    .buildMilestoneMap(settings.usePlaceholderMilestonesForMissingMilestones)
    .then(_ =>
      converter.buildIssueMap(settings.usePlaceholderIssuesForMissingIssues)
    )
    .then(_ =>
      converter.buildMergeRequestMap(
        settings.usePlaceholderIssuesForMissingMergeRequests
      )
    )
    .catch(err => {
      console.error(`Error building maps for repository data: ${err}`);
      process.exit(1);
    });

  try {
    if (settings.transfer.description) {
      await transferDescription();
    }

    if (settings.transfer.milestones) {
      await transferMilestones(
        settings.usePlaceholderMilestonesForMissingMilestones
      );
    }

    if (settings.transfer.labels) {
      // TODO: add settings.useAttachmentLabel
      await transferLabels(true, settings.conversion.useLowerCaseLabels);
    }

    if (settings.transfer.releases) {
      await transferReleases();
    }

    // Important: do this before transferring the merge requests
    if (settings.transfer.issues) {
      await transferIssues(settings.usePlaceholderIssuesForMissingIssues);
    }

    if (settings.transfer.mergeRequests) {
      if (settings.mergeRequests.log) {
        await logMergeRequests(settings.mergeRequests.logFile);
      } else {
        await transferMergeRequests(
          settings.usePlaceholderIssuesForMissingMergeRequests
        );
      }
    }
    if (settings.transfer.attachments) {
      await transferAttachments();
    }
  } catch (err) {
    console.error('Error during transfer:');
    console.error(err);
  }

  console.log('\n\nTransfer complete!\n\n');

  inform(`Statistics`);

  console.log(
    `Total nr. of issues: ${converter.issueMap ? converter.issueMap.size : 0}`
  );
  console.log(
    `Nr. of used placeholder issues: ${counters.nrOfPlaceholderIssues}`
  );
  console.log(`Nr. of issue migration fails: ${counters.nrOfFailedIssues}`);
  console.log(
    `Nr. of used replacement issues: ${counters.nrOfReplacementIssues}`
  );
  console.log(
    `Total nr. of milestones: ${
      converter.milestoneMap ? converter.milestoneMap.size : 0
    }`
  );
  console.log(
    `Nr. of used placeholder milestones: ${counters.nrOfPlaceholderMilestones}`
  );
  console.log(`Total nr. of labels: ${counters.nrOfMigratedLabels}`);
  console.log(`Nr. of label migration fails: ${counters.nrOfFailedLabels}`);
  console.log(
    `Total nr. of merge requests: ${counters.nrOfMigratedMergeRequests}`
  );
  console.log(
    `Nr. of merge request migration fails: ${counters.nrOfFailedMergeRequests}`
  );
}

// ----------------------------------------------------------------------------

/**
 * Transfer the description of the repository.
 */
async function transferDescription() {
  inform('Transferring Description');

  return gitlabApi.Projects.show(settings.gitlab.projectId)
    .then(project =>
      githubHelper.updateRepositoryDescription(project.description ?? '')
    )
    .then(_ => console.log('\t...done'))
    .catch(err => {
      console.error(`\tSomething went wrong: ${err}`);
      throw err;
    });
}

// ----------------------------------------------------------------------------

/**
 * Transfer any milestones that exist in GitLab that do not exist in GitHub.
 */
async function transferMilestones(usePlaceholders: boolean) {
  inform('Transferring Milestones');

  // Get a list of all milestones associated with this project
  // FIXME: don't use type join but ensure everything is milestoneImport
  let milestones: GitLabMilestone[] = await gitlabHelper.getAllMilestones();

  // sort milestones in ascending order of when they were created (by id)
  milestones = milestones.sort((a, b) => a.id - b.id);

  // get a list of the current milestones in the new GitHub repo (likely to be empty)
  const githubMilestones = await githubHelper.getAllGithubMilestones();

  let milestoneMap = new Map<number, SimpleItem>();
  for (let i = 0; i < milestones.length; i++) {
    let milestone = milestones[i];
    let expectedIdx = i + 1; // GitLab internal Id (iid)

    // Create placeholder milestones so that new GitHub milestones will have
    // the same milestone number as in GitLab. Gaps are caused by deleted
    // milestones
    if (usePlaceholders && milestone.iid !== expectedIdx) {
      let placeholder = RepoConverter.createPlaceholderData(
        milestone,
        expectedIdx
      ) as GitLabMilestone;
      milestones.splice(i, 0, placeholder);
      counters.nrOfPlaceholderMilestones++;
      console.log(`Added placeholder for GitLab milestone %${expectedIdx}.`);
      milestoneMap.set(expectedIdx, {
        iid: expectedIdx,
        title: placeholder.title,
      });
    } else {
      milestoneMap.set(milestone.iid, {
        iid: expectedIdx,
        title: milestone.title,
      });
    }
  }

  // if a GitLab milestone does not exist in GitHub repo, create it.

  for (let milestone of milestones) {
    let foundMilestone = githubMilestones.find(
      m => m.title === milestone.title
    );

    if (foundMilestone) {
      console.log('Milestone already exists: ' + milestone.title);
      continue;
    }

    console.log('Migrating milestone %' + milestone.title);
    await githubHelper
      .createMilestone(converter.convertMilestone(milestone))
      .then(created => {
        let m = milestoneMap.get(milestone.iid);
        if (m && m.iid != created.iid) {
          throw new Error(
            `Mismatch between milestone ${m.title} in map and created ${created.title}`
          );
        }
      })
      .catch(err => {
        console.error(`Error creating milestone '${milestone.title}': ${err}`);
        counters.nrOfFailedMilestones++;
      });
  }
}

// ----------------------------------------------------------------------------

/**
 * Transfer any labels that exist in GitLab that do not exist in GitHub.
 */
async function transferLabels(attachmentLabel: boolean, useLowerCase: boolean) {
  inform('Transferring Labels');

  // Get a list of all labels associated with this project
  let labels: GitHubLabelData[] = await gitlabApi.Labels.all(
    settings.gitlab.projectId
  ).then(labels => labels.map(l => converter.convertLabel(l, useLowerCase)));

  // get a list of the current label names in the new GitHub repo (likely to be just the defaults)
  const githubLabels: string[] = await githubHelper.getAllGithubLabelNames();

  // create a hasAttachment label for manual attachment migration
  if (attachmentLabel) {
    const hasAttachmentLabel = {
      name: 'has attachment',
      color: '#fbca04',
      description: 'The issue has an attachment',
    };
    labels.push(hasAttachmentLabel);
  }

  const gitlabMergeRequestLabel = {
    name: 'gitlab merge request',
    color: '#b36b00',
    description:
      'The issue is a placeholder for a merge request that could not be migrated',
  };
  labels.push(gitlabMergeRequestLabel);

  // if a GitLab label does not exist in GitHub repo, create it.
  for (let label of labels) {
    if (githubLabels.find(l => l === label.name)) {
      console.log('Label already exists: ' + label.name);
      continue;
    }

    console.log(`Migrating label: ${label.name}...`);
    await githubHelper
      .createLabel(label)
      .then(() => counters.nrOfMigratedLabels++)
      .catch(err => {
        counters.nrOfFailedLabels++;
        console.error(`\t...ERROR while creating label ${label.name}: ${err}`);
      });
  }
}

// ----------------------------------------------------------------------------

/**
 * Transfer any issues and their comments that exist in GitLab that do not exist in GitHub.
 */
async function transferIssues(usePlaceholders: boolean) {
  inform('Transferring Issues');

  // get a list of all GitLab issues associated with this project
  // TODO return all issues via pagination
  let issues = await gitlabHelper.getAllIssues();

  // sort issues in ascending order of their issue number (by iid)
  issues = issues.sort((a, b) => a.iid - b.iid);

  // get a list of the current issues in the new GitHub repo (likely to be empty)
  const githubIssues = await githubHelper.getAllGithubIssues();

  console.log(`Transferring ${issues.length} issues.`);

  let issueMap = new Map<number, number>();

  for (let i = 0; i < issues.length; i++) {
    let issue = issues[i];
    let expectedIdx = i + 1;

    // Create placeholder issues so that new GitHub issues will have the same
    // issue number as in GitLab. If a placeholder is used it is because there
    // was a gap in GitLab issues -- likely caused by a deleted GitLab issue.
    if (usePlaceholders && issue.iid !== expectedIdx) {
      // HACK: remove type coercion
      let placeholder = RepoConverter.createPlaceholderData(
        issue,
        expectedIdx
      ) as GitLabIssue;
      issues.splice(i, 0, placeholder);
      counters.nrOfPlaceholderIssues++;
      console.log(`Added placeholder for GitLab issue #${expectedIdx}.`);
      issueMap.set(expectedIdx, expectedIdx);
    } else {
      issueMap.set(issue.iid, expectedIdx);
    }
  }

  await githubHelper.registerIssueMap(issueMap);

  //
  // Create GitHub issues for each GitLab issue
  //

  // if a GitLab issue does not exist in GitHub repo, create it -- along with comments.
  for (let issue of issues) {
    // try to find a GitHub issue that already exists for this GitLab issue
    let foundIssue = githubIssues.find(
      i => i.title.trim() === issue.title.trim()
    );
    let issueData = converter.convertIssue(issue);
    if (foundIssue) {
      console.log(`Updating issue #${issue.iid} - ${issue.title}...`);
      await githubHelper
        // FIXME: maybe add a new method updateComments()??
        .updateIssueData(foundIssue.number, issueData)
        .then(_ => console.log(`\t...done updating issue #${issue.iid}.`))
        .catch(err => {
          console.error(`\t...ERROR while updating issue #${issue.iid}.`);
        });

      continue;
    }

    console.log(`\nMigrating issue #${issue.iid} ('${issue.title}')...`);

    const notes = converter.convertNotes(
      await gitlabHelper.getIssueNotes(issue.iid)
    );

    await githubHelper
      .createIssueAndComments(issueData, notes)
      .then(() => console.log(`\t...done migrating issue #${issue.iid}.`))
      .catch(err => {
        console.error(`\t...ERROR while migrating issue #${issue.iid}: ${err}`);

        // TODO delete this after issue-migration fails have been fixed
        console.error('DEBUG:\n', err);
        counters.nrOfFailedIssues++;
        if (settings.useReplacementIssuesForCreationFails) {
          console.log('\t-> creating a replacement issue...');
          const replacementIssue = converter.replacementIssue(issue);

          githubHelper
            .createIssueAndComments(replacementIssue, notes)
            .then(() => {
              counters.nrOfReplacementIssues++;
              console.error('\t...done.');
            })
            .catch(err => {
              console.error(
                '\t...ERROR: Could not create replacement issue either!'
              );
            });
        }
      });
  }
}

// ----------------------------------------------------------------------------

/**
 * Transfer any merge requests that exist in GitLab that do not exist in GitHub
 * TODO - Update all text references to use the new issue numbers;
 *        GitHub treats pull requests as issues, therefore their numbers are changed
 */
async function transferMergeRequests(usePlaceholders: boolean): Promise<void> {
  inform('Transferring Merge Requests');

  // Get a list of all pull requests (merge request equivalent) associated with
  // this project
  let mergeRequests = await gitlabHelper.getAllMergeRequests();

  // Sort merge requests in ascending order of their number (by iid)
  mergeRequests = mergeRequests.sort((a, b) => a.iid - b.iid);

  // Get a list of the current pull requests in the new GitHub repo (likely to
  // be empty)
  const githubPullRequests = await githubHelper.getAllGithubPullRequests();

  // get a list of the current issues in the new GitHub repo (likely to be empty)
  // Issues are sometimes created from Gitlab merge requests. Avoid creating duplicates.
  let githubIssues = await githubHelper.getAllGithubIssues();

  let mrMap = new Map<number, number>();
  // GitHub PRs follow the same numbering as issues. The first PR we create
  // will be after the last issue

  // FIXME: this breaks as soon as we update a repo!!!!

  const lastIssueNumber = Math.max.apply(
    Math,
    Array.from(converter.issueMap.values())
  );

  for (let i = 0; i < mergeRequests.length; i++) {
    let mr = mergeRequests[i];
    let expectedIdx = i + 1;

    // Create placeholder MRs so that references in comments are properly
    // converted. If a placeholder is used it is because there was a gap in the
    // GitLab merge requests -- likely caused by a deleted GitLab MR
    if (usePlaceholders && mr.iid !== expectedIdx) {
      let placeholder = RepoConverter.createPlaceholderData(
        mr,
        expectedIdx
      ) as GitLabMergeRequest;
      mergeRequests.splice(i, 0, placeholder);
      counters.nrOfPlaceholderIssues++;
      console.log(
        `Added placeholder for GitLab merge request !${expectedIdx}.`
      );
      mrMap.set(expectedIdx, expectedIdx + lastIssueNumber);
    } else {
      mrMap.set(mr.iid, expectedIdx + lastIssueNumber);
    }
  }

  // await githubHelper.registerMergeRequestMap(mrMap);

  console.log(
    'Transferring ' + mergeRequests.length.toString() + ' merge requests'
  );

  //
  // Create GitHub pull request for each GitLab merge request
  //

  // if a GitLab merge request does not exist in GitHub repo, create it -- along
  // with comments
  for (let mr of mergeRequests) {
    // Try to find a GitHub pull request that already exists for this GitLab
    // merge request
    let foundPullRequest = githubPullRequests.find(
      i => i.title.trim() === mr.title.trim()
    );
    let foundIssue = githubIssues.find(
      // allow for issues titled "Original Issue Name [merged]"
      i => i.title.trim().includes(mr.title.trim())
    );
    let prData = converter.convertMergeRequest(mr);
    if (!foundPullRequest && !foundIssue) {
      if (settings.skipMergeRequestStates.includes(mr.state)) {
        console.log(
          `Skipping MR ${mr.iid} in "${mr.state}" state: ${mr.title}`
        );
        continue;
      }
      console.log(`Creating pull request: !${mr.iid} - ${mr.title}`);
      const notes = await gitlabHelper.getAllMergeRequestNotes(mr.iid);
      let comments = converter.convertNotes(notes);
      const branches: string[] = (await gitlabHelper.getAllBranches()).map(
        b => b.name
      );

      if (settings.github.useIssueImportAPI) {
        return;
      } else {
        await githubHelper
          .createPullRequest(prData, comments, branches)
          .then(result => {
            if (result === false) {
            }
          })
          .then(_ => counters.nrOfMigratedMergeRequests++)
          .catch(err => {
            counters.nrOfFailedMergeRequests++;
            console.error(
              `Could not create pull request ${mr.iid}-${mr.title}: ${err}.`
            );
          });
      }
    } else {
      if (foundPullRequest) {
        console.log(
          `GitLab merge request already exists as GitHub pull request ${foundPullRequest.number}-${foundPullRequest.title}. Updating all data.`
        );
        await githubHelper.updateIssueData(foundPullRequest.number, prData);
      } else if (foundIssue) {
        console.log(
          `GitLab merge request already exists as GitHub issue ${foundIssue.number}-${foundIssue.title}.`
        );
      }
    }
  }
}

/**
 * Transfer any releases that exist in GitLab that do not exist in GitHub
 * Please note that due to github api restrictions, this only transfers the
 * name, description and tag name of the release. It sorts the releases chronologically
 * and creates them on github one by one
 */
async function transferReleases(): Promise<void> {
  inform('Transferring Releases');

  // Get a list of all releases associated with this project
  let releases = await gitlabApi.Releases.all(settings.gitlab.projectId);

  // Sort releases in ascending order of their release date
  releases = releases.sort((a, b) => {
    return (new Date(a.released_at) as any) - (new Date(b.released_at) as any);
  });

  console.log('Transferring ' + releases.length.toString() + ' releases');

  //
  // Create GitHub release for each GitLab release
  //

  // if a GitLab release does not exist in GitHub repo, create it
  for (let release of releases) {
    // Try to find an existing github release that already exists for this GitLab
    // release
    let githubRelease = await githubHelper.getReleaseByTag(release.tag_name);

    if (!githubRelease) {
      console.log(`Creating release: !${release.name} - ${release.tag_name}`);
      await githubHelper
        .createRelease(release.tag_name, release.name, release.description)
        .catch(err => {
          console.error(
            `Could not create release: !${release.name} - ${release.tag_name}`
          );
          console.error(err);
        });
    } else {
      console.log(
        `GitLab release already exists as GitHub release: !${release.name} - ${release.tag_name}`
      );
    }
  }
}

//-----------------------------------------------------------------------------

/**
 * logs merge requests that exist in GitLab to a file.
 */
async function logMergeRequests(logFile: string) {
  inform('Logging Merge Requests');

  // get a list of all GitLab merge requests associated with this project
  // TODO return all MRs via pagination
  let mergeRequests = await gitlabApi.MergeRequests.all({
    projectId: settings.gitlab.projectId,
    labels: settings.filterByLabel,
  });

  // sort MRs in ascending order of when they were created (by id)
  mergeRequests = mergeRequests.sort((a, b) => a.id - b.id);

  console.log('Logging ' + mergeRequests.length.toString() + ' merge requests');

  for (let mr of mergeRequests) {
    let mergeRequestDiscussions = await gitlabApi.MergeRequestDiscussions.all(
      settings.gitlab.projectId,
      mr.iid
    );
    let mergeRequestNotes = await gitlabApi.MergeRequestNotes.all(
      settings.gitlab.projectId,
      mr.iid,
      {}
    );

    mr.discussions = mergeRequestDiscussions ? mergeRequestDiscussions : [];
    mr.notes = mergeRequestNotes ? mergeRequestNotes : [];
  }

  //
  // Log the merge requests to a file
  //
  const output = { mergeRequests: mergeRequests };

  fs.writeFileSync(logFile, JSON.stringify(output, null, 2));
}

async function transferAttachments() {
  Promise.allSettled(
    Array.from(converter.attachmentMap.values()).map(
      storageHelper.migrateAttachment
    )
  );
}
// ----------------------------------------------------------------------------

/**
 * Print out a section heading to let the user know what is happening
 */
function inform(msg: string) {
  console.log('==================================');
  console.log(msg);
  console.log('==================================');
}
