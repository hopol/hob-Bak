# Hob plugin source

This repository contains the official plugins for [Hob](https://github.com/FFatTiger/hob). The official source is already included in Hob; open Plugins → Market to browse and install a plugin. Installed plugins can require configuration before their services connect.

To create your own source, fork this repository, add a plugin directory, run `node scripts/build-index.mjs`, and commit the resulting `index.json`. In Hob, add the repository address or the raw HTTPS address of its `index.json` as a plugin source. A source can also be hosted as static files, keeping the index and plugin directories together.

## Plugin directory

Each plugin lives in its own directory, named with its ID (letters, digits, `_` or `-`; up to 64 characters, starting with a letter or digit). It contains:

- `plugin.json`: an object with a string `version`; `name`, `displayName` and `description` describe the plugin. `extensions["com.hob.plugins"]` can specify a relative `icon`, a `publisher`, `categories`, and `profiles: { "title": "…" }` for multiple configurations.
- `mcp.json`: an object with `mcpServers`, mapping service names to MCP connection definitions. A service can use a local `command` and `args`, or a remote `url`, with optional `env`, `headers` and OAuth settings as appropriate.
- An optional icon and `skills/` directories. Include every file needed by the plugin in the plugin directory.

`plugin.json` can declare `userConfig` as an object keyed by configuration variable name. Each field has a `type` (`string`, `number`, `boolean`, `file`, or `directory`) and can specify `title`, `description`, `required`, `default`, `options`, `multiple`, `sensitive`, `min`, and `max`. References such as `${user_config.KEY}` can be used in MCP arguments, URLs, headers and environment values. Sensitive values are stored separately by Hob. The paths `${hob.root}`, `${hob.plugin_root}` and `${hob.plugin_data}` refer to the Hob installation, installed plugin and persistent plugin data directories. A plugin declaring profiles uses `${hob.profiles}` for its configuration and cannot use OAuth or individual user configuration references.

The generated index lists each ID, directory path and relative file paths. Hob can also read an index without `files` over HTTP; in that case it retrieves only `plugin.json`, `mcp.json` and the declared icon. A git source includes the complete plugin directory.

## License

MIT; see [LICENSE](LICENSE).
