# Hob 插件源

这个仓库存放 [Hob](https://github.com/FFatTiger/hob) 官方插件。Hob 已内置官方源，在「插件 → 市场」里即可浏览和安装；部分插件需要填写配置后才能连接服务。

要建立自己的源，可以 fork 这个仓库，添加插件目录，运行 `node scripts/build-index.mjs`，提交生成的 `index.json`，然后在 Hob 里添加仓库地址或 `index.json` 的 HTTPS raw 地址。也可以把索引和插件目录一起放在静态文件服务器上。

## 插件目录

每个插件一个目录，目录名就是 ID（字母、数字、`_` 或 `-`，最多 64 个字符，以字母或数字开头）：

- `plugin.json`：对象，`version` 是字符串；`name`、`displayName` 和 `description` 用于描述插件。`extensions["com.hob.plugins"]` 可以指定相对路径 `icon`、`publisher`、`categories`，以及支持多套配置的 `profiles: { "title": "…" }`。
- `mcp.json`：对象，`mcpServers` 把服务名映射到 MCP 连接配置。服务可以使用本地 `command` 和 `args`，或远程 `url`，并按需填写 `env`、`headers` 和 OAuth 配置。
- 可选图标和 `skills/` 目录。插件需要的文件都放在插件目录中。

`plugin.json` 的 `userConfig` 可按变量名声明配置项。每项有 `type`（`string`、`number`、`boolean`、`file` 或 `directory`），还可填写 `title`、`description`、`required`、`default`、`options`、`multiple`、`sensitive`、`min` 和 `max`。MCP 参数、地址、请求头和环境变量中可用 `${user_config.KEY}` 引用配置，敏感值由 Hob 单独保存。`${hob.root}`、`${hob.plugin_root}`、`${hob.plugin_data}` 分别代表 Hob 安装目录、已安装插件目录和插件持久数据目录。声明 profiles 的插件用 `${hob.profiles}` 读取配置，不能使用 OAuth 或单个配置引用。

生成的索引记录每个插件的 ID、目录路径和相对文件清单。HTTP 索引也可以不写 `files`，此时 Hob 只取 `plugin.json`、`mcp.json` 和声明的图标；git 源包含完整的插件目录。

## 许可

MIT，见 [LICENSE](LICENSE)。
