/**
 * Variables that set where a package publish goes (review round 2 of
 * ATO-2528): npm's `npm_config_registry` / `userconfig`, yarn's, cargo's,
 * twine's, poetry's and gem's. Set for the call, or in the agent's own
 * environment (which the command inherits), they make the registry one
 * the egress scan does not read, so the publish counts as going to an
 * unknown host. Pure: shared by `egress-scan.ts` and `shell-egress.ts`.
 */
export const REGISTRY_VARIABLE_RE =
  /^(?:npm_config_(?:registry|userconfig|globalconfig|@[^=]*:registry)|yarn_npm_(?:publish_registry|registry_server|scopes)|yarn_rc_filename|cargo_registry_default|cargo_registries_[a-z0-9_]+_index|cargo_home|twine_repository(?:_url)?|poetry_repositories_[a-z0-9_]+_url|rubygems_host)$/i;

/** Whether `env` sets one of `REGISTRY_VARIABLE_RE` to something. */
export function registryVariableSet(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => REGISTRY_VARIABLE_RE.test(key) && (value ?? "").length > 0);
}
