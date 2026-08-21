const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require("path");

/**
 * Monorepo Metro config: watch the workspace root so the app can import the
 * pure-TS @adaptivemesh/core package directly from packages/core.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = {
	watchFolders: [workspaceRoot],
	resolver: {
		nodeModulesPaths: [path.resolve(projectRoot, "node_modules"), path.resolve(workspaceRoot, "node_modules")],
	},
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
