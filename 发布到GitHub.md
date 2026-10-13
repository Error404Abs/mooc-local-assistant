# 发布到 GitHub

此文件夹是独立发布副本，不是你日常运行的桌面安装目录。整理阶段没有创建仓库、提交或上传。

1. 登录 GitHub，点击右上角 **+ → New repository**，填写仓库名，例如 `mooc-local-assistant`。
2. 阅读 README 和 MIT 许可证，确认愿意按 MIT 允许他人使用、修改和再分发你的代码后再发布。想先检查可选择 Private，确认后再改 Public。
3. 不勾选 GitHub 自动生成 README、许可证或 .gitignore，因为此目录已包含。
4. 创建仓库后选择 **uploading an existing file**。将发布文件夹里的内容上传到仓库根目录，不要只上传 ZIP，也不要只上传外层文件夹。务必包含 `.gitignore`、`.github/workflows/test.yml` 和 `tests`。
5. 核对文件列表：不得包含个人 `config.json`、`local-data`、连接码、API key、截图、日志或 `node_modules`。本目录里的 `config.example.json` 可以上传，它没有密钥。
6. 点击 **Commit changes**。打开仓库的 Actions 标签页查看测试结果。自动化工作流第一次运行前可能需要启用 Actions。

后续维护时，在自己的本机副本复制示例配置，不要上传真实配置。不要把现有桌面「MOOC弹题助手」中的缓存和连接码复制进此发布目录。

源代码采用 MIT；课程内容、平台商标和第三方依赖并不自动适用本许可证。发布不意味着平台允许自动作答。发布前请确认平台规则与课程要求，并完整保留 README 中的使用限制。
