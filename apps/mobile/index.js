/**
 * RN entry point. Registers the root component with the native AppRegistry.
 *
 * `./polyfills` MUST stay the first import: it installs Buffer / TextEncoder /
 * TextDecoder globals that @adaptivemesh/core needs and Hermes does not ship.
 * ES module imports are evaluated in order before this file's body runs, so
 * importing it first guarantees the globals exist before App (and the mesh
 * stack it pulls in) is evaluated.
 */
import "./polyfills";
import { AppRegistry } from "react-native";
import App from "./App";
import { name as appName } from "./app.json";

AppRegistry.registerComponent(appName, () => App);
