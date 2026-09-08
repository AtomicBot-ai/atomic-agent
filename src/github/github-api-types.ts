/**
 * Shapes shared by `GithubApi` and its parsers. Records are the small
 * subset of GitHub's payloads the tools actually show; nothing here
 * leaks the raw API object.
 */

import { scrubGithubToken } from "./github-token.js";

export class GithubApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(scrubGithubToken(message));
    this.name = "GithubApiError";
    this.status = status;
  }
}

export interface GithubIdentity {
  login: string;
  name: string | null;
  /**
   * OAuth scopes GitHub reports in `X-OAuth-Scopes`. Populated for
   * classic PATs and `gh` tokens; fine-grained PATs carry no scopes
   * header, so an empty list is not by itself a problem.
   */
  scopes: readonly string[];
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  permissions: { push: boolean; admin: boolean };
}

export interface GithubPullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  head: string;
  base: string;
  htmlUrl: string;
  author: string;
  createdAt: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  author: string;
  labels: readonly string[];
  createdAt: string;
  /** Present when GitHub returned a PR through the issues endpoint. */
  isPullRequest: boolean;
}

export interface GithubComment {
  id: number;
  htmlUrl: string;
}

export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface CreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: readonly string[];
}

export interface GithubApiOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

