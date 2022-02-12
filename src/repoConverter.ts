import settings from '../settings';
import {
  GitHubHelper,
  GitHubIssueData,
  GitHubLabelData,
  GitHubCommentData,
  GitHubMilestoneData,
  GitHubPullRequestData,
} from './githubHelper';
import {
  GitLabHelper,
  GitLabNote,
  GitLabIssue,
  GitLabLabel,
  GitLabMilestone,
  GitLabMergeRequest,
  GitLabPosition,
  GitLabUser,
} from './gitlabHelper';
import { SimpleItem } from './utils';
import {
  AttachmentMetadata,
  PassThroughStorageHelper,
  S3Helper,
  StorageHelper,
} from './storageHelper';
import { String } from 'aws-sdk/clients/cloudwatchevents';

/**
 * Handles mapping and conversion of GitLab items into GitHub items.
 *
 *  - Creates and maintains the mapping of milestones, issues, and merge requests
 *  - Converts GitLab objects into parameters for requests to create GitHub
 *    objects (e.g. GitLabMergeRequest into GitHubPullRequestData)
 *  - ...
 */
export class RepoConverter {
  githubHelper: GitHubHelper;
  gitlabHelper: GitLabHelper;
  storageHelper: StorageHelper;

  milestoneMap?: Map<number, SimpleItem>;
  issueMap?: Map<number, number>;
  mrMap?: Map<number, number>;
  attachmentMap: Map<string, AttachmentMetadata>;

  constructor(
    gitlabHelper: GitLabHelper,
    githubHelper: GitHubHelper,
    storageHelper: StorageHelper
  ) {
    this.gitlabHelper = gitlabHelper;
    this.githubHelper = githubHelper;
    this.storageHelper = storageHelper;
    this.attachmentMap = new Map<string, AttachmentMetadata>();
  }

  /**
   * Builds a map GitLab milestone -> GitHub milestone before actually creating
   * any milestones in GitHub. This is necessary in order to correctly convert
   * references in comments of the type !NN or !"milestone title" to links in
   * the GitHub repo.
   *
   * @param gitlabMilestones A list of all milestones in the GitLab project
   * @param usePlaceholders Whether the migration will insert placeholder
   *   milestones in place of deleted ones to keep the numbering consistent.
   */
  async buildMilestoneMap(usePlaceholders: boolean) {
    let githubMilestones = await this.githubHelper.getAllGithubMilestones();
    let gitlabMilestones = await this.gitlabHelper.getAllMilestones();

    // Compute the first available ID for newly imported milestones
    let lastMilestoneId = 0;
    githubMilestones.forEach(milestone => {
      lastMilestoneId = Math.max(lastMilestoneId, milestone.iid);
    });

    let milestoneMap = new Map<number, SimpleItem>();
    let expectedIdx = 0;
    for (let milestone of gitlabMilestones) {
      expectedIdx++;
      let foundMilestone = githubMilestones.find(
        m => m.title === milestone.title
      );

      if (foundMilestone) {
        milestoneMap.set(milestone.iid, foundMilestone);
        lastMilestoneId = Math.max(lastMilestoneId, foundMilestone.iid);
      } else {
        if (usePlaceholders) {
          lastMilestoneId = Math.max(lastMilestoneId, milestone.iid - 1);
        }
        milestoneMap.set(milestone.iid, {
          iid: ++lastMilestoneId,
          title: milestone.title,
        });
      }
    }
    return milestoneMap;
  }

  /**
   * Meh...
   * @param gitlabIssues
   * @param usePlaceholders
   */
  async buildIssueMap(usePlaceholders: boolean) {
    let githubIssues = await this.githubHelper.getAllGithubIssues();
    let gitlabIssues = await this.gitlabHelper.getAllIssues();

    let issueMap = new Map<number, number>();
    githubIssues.forEach(issue => issueMap.set(issue.number, issue.number));
    return issueMap;
  }

  /**
   * Meh...
   * @param mergeRequests
   * @param usePlaceholders
   */
  async buildMergeRequestMap(usePlaceholders: boolean) {
    if (!this.issueMap) throw Error('issueMap not initialised');
    let pullRequests = await this.githubHelper.getAllGithubPullRequests();
    let mergeRequests = await this.gitlabHelper.getAllMergeRequests();

    mergeRequests = mergeRequests.sort((a, b) => a.iid - b.iid);
    let mrMap = new Map<number, number>();
    const lastIssueNumber = Math.max.apply(
      Math,
      Array.from(this.issueMap.values())
    );
    for (let i = 0; i < mergeRequests.length; i++) {
      let mr = mergeRequests[i];
      let expectedIdx = i + 1;
      if (usePlaceholders && mr.iid !== expectedIdx) {
        mrMap.set(expectedIdx, expectedIdx + lastIssueNumber);
      } else {
        mrMap.set(mr.iid, expectedIdx + lastIssueNumber);
      }
    }
    return mrMap;
  }

  /**
   * Returns the GitHub milestone id for a milestone GitLab property of an issue or MR
   *
   * Note that this requires a milestoneMap to be built.
   */
  mapMilestone(item: GitLabIssue | GitLabMergeRequest): number | undefined {
    if (!this.milestoneMap) throw Error('milestoneMap not initialised');
    if (!item.milestone) return undefined;

    for (let m of this.milestoneMap.values())
      if (m.title == item.milestone.title) return m.iid;

    return undefined;
  }

  /**
   * Converts GitLab assignees to GitHub usernames, using settings.usermap
   */
  convertAssignees(item: GitLabIssue | GitLabMergeRequest): string[] {
    if (!item.assignees) return [];
    let assignees: string[] = [];
    for (let assignee of item.assignees) {
      let username: string = assignee.username as string;
      if (username === settings.github.username) {
        assignees.push(settings.github.username);
      } else if (settings.usermap && settings.usermap[username]) {
        assignees.push(settings.usermap[username]);
      }
    }
    return assignees;
  }

  convertMergeRequest(mergeRequest: GitLabMergeRequest): GitHubPullRequestData {
    let isClosed =
      mergeRequest.state === 'merged' || mergeRequest.state === 'closed';
    return {
      head: mergeRequest.source_branch,
      base: mergeRequest.target_branch,
      title: mergeRequest.title.trim(),
      body: this.convertBody(mergeRequest.description, mergeRequest),
      draft: mergeRequestIsDraft(mergeRequest),
      labels: this.convertLabelNames(mergeRequest),
      closed: isClosed,
      // Merging the pull request adds new commits to the tree; to avoid that, just close the merge requests
      state: isClosed ? 'closed' : 'open',
    };
  }

  convertMilestone(milestone: GitLabMilestone): GitHubMilestoneData {
    return {
      description: this.convertBody(milestone.description, milestone, false),
      state: milestone.state === 'active' ? 'open' : 'closed',
      title: milestone.title,
      due_on: milestone.due_date
        ? milestone.due_date + 'T00:00:00Z'
        : undefined,
    };
  }

  /**
   * Converts a GitLab label into the data for a GitHub label.
   *
   * @param label The GitLab label object
   * @param useLowerCase Whether or not to convert to lowercase
   * @returns The parameters for the GitHub API call
   */
  convertLabel(label: GitLabLabel, useLowerCase: boolean): GitHubLabelData {
    return {
      name: useLowerCase ? label.name.toLowerCase() : label.name,
      // github wants colors without leading '#'
      color: label.color.startsWith('#')
        ? label.color.substring(1)
        : label.color,
      description: label.description.slice(0, 100), // Max 100 chars per API spec
    };
  }

  /**
   * Converts a string into one of 'open' or 'closed'. Defaults to 'open'.
   *
   * @param state The state string
   */
  convertState(state: string): 'open' | 'closed' {
    switch (state.toLowerCase()) {
      case 'open':
        return 'open';
      case 'closed':
        return 'closed';
      default:
        return 'open';
    }
  }

  /**
   * Converts GitLab labels to GitHub label names.
   *
   * This also adds "has attachment" if the issue links to data.
   */
  convertLabelNames(item: GitLabIssue | GitLabMergeRequest): string[] {
    let labels: string[] = [];
    if (item.labels) {
      labels = item.labels.filter(l => {
        if (item.state !== 'closed') return true;

        let lower = l.toLowerCase();
        // ignore any labels that should have been removed when the issue was closed
        return lower !== 'doing' && lower !== 'to do';
      });
      if (settings.conversion.useLowerCaseLabels) {
        labels = labels.map((el: string) => el.toLowerCase());
      }
    }

    // If the item's description contains a url that contains "/uploads/",
    // it is likely to have an attachment
    if (
      item.description &&
      item.description.indexOf('/uploads/') > -1 &&
      !settings.s3
    ) {
      labels.push('has attachment');
    }

    return labels;
  }

  convertIssue(issue: GitLabIssue): GitHubIssueData {
    let bodyConverted = this.convertBody(
      issue.description ?? '',
      issue,
      !userIsCreator(issue.author) || !issue.description
    );

    const assignees = this.convertAssignees(issue);

    return {
      title: issue.title ? issue.title.trim() : '',
      body: bodyConverted,
      assignees: assignees,
      assignee: assignees.length == 1 ? assignees[0] : undefined,
      milestone: this.mapMilestone(issue),
      labels: this.convertLabelNames(issue),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      state: this.convertState(issue.state),
    };
  }

  /**
   * FIXME: import API accepts created_at but standard api doesn't
   * @param notes
   * @returns Comments sorted and converted, ready for requestImportIssue()
   */
  convertNotes(
    notes: GitLabNote[],
    issue_number?: number
  ): GitHubCommentData[] {
    const comments: GitHubCommentData[] = notes
      .sort((a, b) => a.id - b.id)
      .filter(RepoConverter.checkIfNoteCanBeSkipped)
      .map(
        note =>
          <GitHubCommentData>{
            issue_number: issue_number,
            created_at: note.created_at,
            body: this.convertBody(
              note.body,
              note,
              !userIsCreator(note.author) || !note.body
            ),
          }
      );

    return comments;
  }

  /**
   * This function checks if a note needs to be processed or if it can be skipped.
   * A note can be skipped if it contains predefined terms (like 'Status changed to...')
   * or if it contains any value from settings.skipMatchingComments ->
   * Note that this is case insensitive!
   *
   */
  static checkIfNoteCanBeSkipped(note: GitLabNote): boolean {
    const body = note.body;
    const stateChange =
      (/Status changed to .*/i.test(body) &&
        !/Status changed to closed by commit.*/i.test(body)) ||
      /^changed milestone to .*/i.test(body) ||
      /^Milestone changed to .*/i.test(body) ||
      /^(Re)*assigned to /i.test(body) ||
      /^added .* labels/i.test(body) ||
      /^Added ~.* label/i.test(body) ||
      /^removed ~.* label/i.test(body) ||
      /^mentioned in issue #\d+.*/i.test(body) ||
      // /^marked this issue as related to #\d+/i.test(noteBody) ||
      /^mentioned in merge request !\d+/i.test(body) ||
      /^changed the description.*/i.test(body) ||
      /^changed title from.*to.*/i.test(body);

    const matchingComment = settings.skipMatchingComments.reduce(
      (a, b) => a || new RegExp(b, 'i').test(body),
      false
    );

    return stateChange || matchingComment;
  }

  /**
   * Converts an issue body, comment or item description from GitLab to GitHub.
   * This means:
   *
   * - (optionally) Adds a line at the beginning indicating which original user created the
   *   issue or the comment and when - because the GitHub API creates everything
   *   as the API user
   * - Changes username from GitLab to GitHub in "mentions" (@username)
   * - Changes milestone references to links
   * - Changes MR references to PR references, taking into account the changes
   *   in indexing due to GitHub PRs using following the same numbering as
   *   issues
   * - Changes issue numbers (necessary e.g. if dummy GH issues were not
   *   created for deleted GL issues).
   *
   * FIXME: conversion should be deactivated depending on the context in the
   *  markdown, e.g. strike-through text for labels, or code blocks for all
   *  references.
   *
   * NOTE: We assume that scoped references 'user/repo#id' are to other
   *       repositories for which we don't have a conversion map.
   *
   * @param str Body of the GitLab note
   * @param item GitLab item to which the note belongs
   * @param add_line Set to true to add the line with author and creation date
   */
  convertBody(
    str: string,
    item: GitLabIssue | GitLabMergeRequest | GitLabNote | GitLabMilestone,
    add_line: boolean = true
  ): string {
    // A note on implementation:
    // We don't convert project names once at the beginning because otherwise
    // we would have to check whether "text#23" refers to issue 23 or not, and
    // so on for MRs, milestones, etc.
    // Instead we consider either project#issue or " #issue" with non-word char
    // before the #, and we do the same for MRs, labels and milestones.

    const repoLink = `${this.githubHelper.githubUrl}/${this.githubHelper.githubOwner}/${this.githubHelper.githubRepo}`;
    const hasUsermap =
      settings.usermap !== null && Object.keys(settings.usermap).length > 0;
    const hasProjectmap =
      settings.projectmap !== null &&
      Object.keys(settings.projectmap).length > 0;

    if (add_line) str = RepoConverter.addMigrationLine(str, item, repoLink);
    let reString = '';

    //
    // User name conversion
    //

    if (hasUsermap) {
      reString = '@' + Object.keys(settings.usermap).join('|@');
      str = str.replace(
        new RegExp(reString, 'g'),
        match => '@' + settings.usermap[match.substring(1)]
      );
    }

    //
    // Issue reference conversion
    //

    let issueReplacer = (match: string) => {
      let issue: number;
      if (this.issueMap && this.issueMap.has(parseInt(match))) {
        issue = this.issueMap.get(parseInt(match)) as number;
        console.log(`\tSubstituted #${issue} for #${match}.`);
        return '#' + issue;
      } else {
        console.log(`\tIssue ${match} not found in issue map.`);
        return '#' + match;
      }
    };

    if (hasProjectmap) {
      reString =
        '(' + Object.keys(settings.projectmap).join(')#(\\d+)|(') + ')#(\\d+)';
      // Don't try to map references to issues in other repositories
      str = str.replace(
        new RegExp(reString, 'g'),
        (_, p1, p2) => settings.projectmap[p1] + '#' + p2
      );
    }
    reString = '(?<=\\W)#(\\d+)';
    str = str.replace(new RegExp(reString, 'g'), (_, p1) => issueReplacer(p1));

    //
    // Milestone reference replacement
    //

    let milestoneReplacer = (
      number: string = '',
      title: string = '',
      repo: string = ''
    ) => {
      let milestone: SimpleItem | undefined;
      if (this.milestoneMap) {
        if (number) {
          milestone = this.milestoneMap.get(parseInt(number));
        } else if (title) {
          for (let m of this.milestoneMap.values()) {
            if (m.title === title) {
              milestone = m;
              break;
            }
          }
        }
      }
      if (milestone) {
        const repoLink = `${this.githubHelper.githubUrl}/${
          this.githubHelper.githubOwner
        }/${repo || this.githubHelper.githubRepo}`;
        return `[${milestone.title}](${repoLink}/milestone/${milestone.iid})`;
      }
      console.log(
        `\tMilestone %'${number || title}' not found in milestone map.`
      );
      return `'Reference to deleted milestone %${number || title}'`;
    };

    if (hasProjectmap) {
      const repoMapLink = (repo: string) =>
        `${this.githubHelper.githubUrl}/${this.githubHelper.githubOwner}/${settings.projectmap[repo]}`;

      // Replace: project%"Milestone"
      reString =
        '(' +
        Object.keys(settings.projectmap).join(')%(".*?")|(') +
        ')%(".*?")';
      str = str.replace(
        new RegExp(reString, 'g'),
        (_, p1, p2) =>
          `[Milestone "${p2}" in ${settings.projectmap[p1]}](${repoMapLink(
            p1
          )}/milestones})`
      );

      // Replace: project%nn
      reString =
        '(' + Object.keys(settings.projectmap).join(')%(\\d+)|(') + ')%(\\d+)';
      str = str.replace(
        new RegExp(reString, 'g'),
        (_, p1, p2) =>
          `[Milestone ${p2} in ${settings.projectmap[p1]}](${repoMapLink(
            p1
          )}/milestone/${p2})`
      );
    }
    // Replace: %"Milestone"
    reString = '(?<=\\W)%"(.*?)"';
    str = str.replace(new RegExp(reString, 'g'), (_, p1) =>
      milestoneReplacer('', p1)
    );

    // Replace: %nn
    reString = '(?<=\\W)%(\\d+)';
    str = str.replace(new RegExp(reString, 'g'), (_, p1) =>
      milestoneReplacer(p1, '')
    );

    //
    // Label reference conversion
    //

    // FIXME: strike through in markdown is done as in: ~this text~
    // These regexes will capture ~this as a label. If it is among the migrated
    // labels, then it will be linked.

    let labelReplacer = (label: string) => {};

    // // Single word named label
    // if (hasProjectmap) {
    //   const reChunk = '~([^~\\s\\.,;:\'"!@()\\\\\\[\\]])+(?=[^~\\w])';
    //   reString =
    //     '('
    //     + Object.keys(settings.projectmap).join(')' + reChunk + '|(')
    //     + ')'
    //     + reChunk;
    //   str = str.replace(new RegExp(reString, 'g'),
    //   (_, p1, p2) => )

    //   TODO
    // } else {
    //   ...
    // }

    // // Quoted named label
    // reString = '~"([^~"]|\\w)+"(?=[^~\\w])';

    //
    // MR reference conversion
    //
    let mrReplacer = (match: string) => {
      let pr: number;
      if (this.mrMap && this.mrMap.has(parseInt(match))) {
        pr = this.mrMap.get(parseInt(match)) as number;
        console.log(`\tSubstituted #${pr} for !${match}.`);
        return '#' + pr;
      } else {
        console.log(`\tMR ${match} not found in merge request map.`);
        return '!' + match; // Return as is
      }
    };

    if (hasProjectmap) {
      reString =
        '(' + Object.keys(settings.projectmap).join(')!(\\d+)|(') + ')!(\\d+)';
      // Don't try to map references to merge requests in other repositories
      str = str.replace(
        new RegExp(reString, 'g'),
        (_, p1, p2) => settings.projectmap[p1] + '#' + p2
      );
    }
    reString = '(?<=\\W)!(\\d+)';
    str = str.replace(new RegExp(reString, 'g'), (_, p1) => mrReplacer(p1));

    if (settings.transfer.attachments) {
      str = this.convertAttachments(str);
    }

    return str;
  }

  /**
   * Populates the attachmentMap and replaces attachment links to point to the
   * proper location, according to the storage helper.
   *
   * @param body Text of the gitlab note to migrate
   */
  convertAttachments(body: string): string {
    const regexp = /(!?)\[([^\]]+)\]\((\/uploads[^)]+)\)/g;

    // Maps position in the text to the replacement URL for the link
    const offsetToAttachment: {
      [key: number]: string;
    } = {};

    const matches = body.matchAll(regexp);

    for (const match of matches) {
      const prefix = match[1] || '';
      const name = match[2];
      const url = match[3];

      let data = this.storageHelper.preprocessAttachment(url);
      this.attachmentMap.set(data.origin, data);

      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${data.destination})`;
    }

    return body.replace(
      regexp,
      ({}, {}, {}, {}, offset, {}) => offsetToAttachment[offset]
    );
  }

  /**
   * Creates dummy data for a placeholder issue / milestone / merge request
   *
   * @param expectedIdx Number of the GitLab item
   * @returns Data for the item
   */
  static createPlaceholderData(
    item: GitLabIssue | GitLabMilestone | GitLabMergeRequest,
    expectedIdx: number
  ): SimpleItem {
    return {
      iid: expectedIdx,
      title: `[PLACEHOLDER] - for ${typeof item} #${expectedIdx}`,
      description:
        'This is to ensure that the numbering in GitHub is consistent. In particular it helps with auto-references in comments using #, %, !, etc.',
      state: 'closed',
    };
  }

  /**
   * Creates a so-called "replacement-issue".
   *
   * This is used for issues where the migration fails. The replacement issue will
   * have the same number and title, but the original description will be lost.
   */
  replacementIssue(issue: GitLabIssue): GitHubIssueData {
    let description = `The original issue\n\n\tId: ${issue.iid}\n\tTitle: ${issue.title}\n\ncould not be created.\nThis is a dummy issue, replacing the original one.`;

    if (issue.web_url) {
      description += `In case the gitlab repository still exists, visit the following link to see the original issue:\n\n${issue.web_url}`;
    }

    return {
      title: `${issue.title} [REPLACEMENT ISSUE]`,
      body: description,
      state: this.convertState(issue.state),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      labels: [],
    };
  }

  /**
   * Adds a line of text at the beginning of a comment that indicates who, when
   * and from GitLab.
   */
  static addMigrationLine(str: string, item: any, repoLink: string): string {
    if (!item || !item.author || !item.author.username || !item.created_at) {
      return str;
    }

    const dateformatOptions: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    };

    const formattedDate = new Date(item.created_at).toLocaleString(
      'en-US',
      dateformatOptions
    );

    const attribution = `In GitLab by @${item.author.username} on ${formattedDate}`;
    const lineRef =
      item && item.position
        ? RepoConverter.createLineRef(item.position, repoLink)
        : '';
    const summary = attribution + (lineRef ? `\n\n${lineRef}` : '');

    return `${summary}\n\n${str}`;
  }

  /**
   * When migrating in-line comments to GitHub, create a link to the
   * appropriate line of the diff.
   */
  static createLineRef(position: GitLabPosition, repoLink: string): string {
    if (
      !repoLink ||
      !repoLink.startsWith(settings.github.baseUrl) ||
      !position ||
      !position.head_sha
    ) {
      return '';
    }
    const base_sha = position.base_sha;
    const head_sha = position.head_sha;
    var path = '';
    var line: number | '' = '';
    var slug = '';
    if (
      (position.new_line && position.new_path) ||
      (position.old_line && position.old_path)
    ) {
      var side;
      if (!position.old_line || !position.old_path) {
        side = 'R';
        path = position.new_path;
        line = position.new_line;
      } else {
        side = 'L';
        path = position.old_path;
        line = position.old_line;
      }
      const crypto = require('crypto');
      const hash = crypto.createHash('md5').update(path).digest('hex');
      slug = `#diff-${hash}${side}${line}`;
    }
    // Mention the file and line number. If we can't get this for some reason then use the commit id instead.
    const ref = path && line ? `${path} line ${line}` : `${head_sha}`;
    return `Commented on [${ref}](${repoLink}/compare/${base_sha}..${head_sha}${slug})\n\n`;
  }
}

function userIsCreator(author: GitLabUser) {
  return (
    author &&
    ((settings.usermap &&
      settings.usermap[author.username as string] ===
        settings.github.token_owner) ||
      author.username === settings.github.token_owner)
  );
}

/**
 * Returns true if the MR is marked as draft
 */
function mergeRequestIsDraft(mergeRequest: GitLabMergeRequest): boolean {
  // See https://docs.gitlab.com/ee/user/project/merge_requests/drafts.html
  return new RegExp(
    '^(draft:|wip:|\\((draft|wip)\\))|\\[(draft|wip)\\]',
    'i'
  ).test(mergeRequest.title);
}
