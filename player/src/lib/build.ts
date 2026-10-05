/** The running build: package version, git commit (with `-dirty` for uncommitted changes) and build time. */
export const build = __BUILD__;

/** e.g. `0.1.0 (a539ca7)`, the same string in the playback log and on the Account page. */
export const buildLabel = `${build.version} (${build.commit})`;
