# Hob 补丁

来源：`pi-claude-bridge@0.9.3`，MIT，原许可证见 `LICENSE`。

- 只读取 Hob 引擎目录的 `claude-bridge.json`，不合并任务工作目录的配置。
- Claude Code 普通请求和摘要请求都传 `--safe-mode`；摘要请求不再传空的 `settingSources`，因为当前 Claude Code 登录在该参数下不可用。
- 不通过全局环境设置安全模式，避免影响用户在任务中启动的 Claude Code。
- Hob 在模型目录初始化时预注册模型，所有会话复用同一个扩展模块；生命周期清理仅影响当前会话，避免并行对话和任务互相清除状态。
- 不修改 Hob 进程的 Claude Code 环境变量；启用桥调试日志时记录实际追加的系统提示词，供隔离验收。
- 移除桥直接读取、重建和删除 Claude Code 会话文件的路径。无法直接续接时，以 SDK 消息重放 Hob 自己的历史（包含图片）；正常续接仍由 Claude Code 处理。这可能增加重启或上下文改写后的 token 用量。
