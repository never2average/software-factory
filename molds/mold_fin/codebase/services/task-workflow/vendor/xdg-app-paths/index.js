// Compatible subset of xdg-app-paths 5.1.0 (MIT). The upstream package reads
// process.argv[0] during module initialization; Next page-data workers expose
// an empty argv. This fork adds process.execPath as the final fallback.
"use strict";

const path = require("node:path");
const xdg = require("xdg-portable");

function normalize(options, isolated) {
  const value = typeof options === "object" && options !== null ? options : { isolated: options };
  const result = { ...value, isolated: value.isolated == null ? isolated : value.isolated };
  if (typeof result.isolated !== "boolean") throw new TypeError("isolated must be a boolean");
  return result;
}

function methods(name, isolated) {
  const append = (base, options) => {
    const value = normalize(options, isolated);
    return path.join(base, value.isolated ? name : "");
  };
  return {
    cache: (options = { isolated: null }) => append(xdg.cache(), options),
    config: (options = { isolated: null }) => append(xdg.config(), options),
    data: (options = { isolated: null }) => append(xdg.data(), options),
    state: (options = { isolated: null }) => append(xdg.state(), options),
    runtime: (options = { isolated: null }) => xdg.runtime() ? append(xdg.runtime(), options) : undefined,
    configDirs: (options = { isolated: null }) => xdg.configDirs().map((dir) => append(dir, options)),
    dataDirs: (options = { isolated: null }) => xdg.dataDirs().map((dir) => append(dir, options)),
  };
}

function create(options = { name: null, suffix: null, isolated: true }) {
  const value = typeof options === "object" && options !== null ? options : { name: options };
  const isolated = value.isolated == null ? true : value.isolated;
  if (typeof isolated !== "boolean") throw new TypeError("isolated must be a boolean");
  const entry = require.main?.filename || process.argv[0] || process.execPath;
  let name = value.name || path.parse(entry).name;
  if (typeof name !== "string") throw new TypeError("name must be a string");
  const suffix = value.suffix || "";
  if (typeof suffix !== "string") throw new TypeError("suffix must be a string");
  name += suffix;
  const callable = (nextOptions) => create(nextOptions);
  callable.$name = () => name;
  callable.$isolated = () => isolated;
  Object.assign(callable, methods(name, isolated));
  return callable;
}

module.exports = create();
