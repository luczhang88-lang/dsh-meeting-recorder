# 发布备注

公开仓库：https://github.com/luczhang88-lang/dsh-meeting-recorder

账号可以公开写作者 Luc Zhang 与 GitHub 账号 `luczhang88-lang`。

1. 改动走分支和 Pull Request 进入 `main`。不要强推，不要在检查前自行合并。
2. 仓库 Settings → Topics：`dsh-plugin`、`deepseek-harness`、`asr`、`meeting`。Topic 只帮助别人在 GitHub 上找到仓库。
3. 安装说明以根目录 [INSTALL.md](./INSTALL.md) 为准：先让 Harness 加载插件，再在那一份目录里 setup。
4. 不要提交 `engine/.venv`、`engine/models`、录音、转写、纪要、`.env` 或密钥。

本次没有 `npm publish`。npm 上还没有这个包的发布流程时，不要用个人凭据登录 npm。
