// Real commands for this repo. `test` is the fixture suite under packages/.
// `lint` and `coverage` are null because this repo configures neither.
export const repoCommands = { lint: null, test: "bun test packages", coverage: null } as const;
export default { repoCommands };
