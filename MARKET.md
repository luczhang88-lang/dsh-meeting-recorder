# 收录说明

## GitHub topic

`dsh-plugin`、`deepseek-harness`、`asr`、`meeting` 是仓库上的发现标签。公开仓库打上 `dsh-plugin` 后，可以出现在：

https://github.com/topics/dsh-plugin

这只表示 GitHub 的 topic 页面能按标签找到仓库。它不保证 DeepSeek Harness 或别的插件市场会自动建索引。

别人在仓库公开后可以安装代码：

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:luczhang88-lang/dsh-meeting-recorder
```

根目录 `package.json` 含 `dsh.bundle`。安装之后还要按 [INSTALL.md](./INSTALL.md) 在**被加载的插件目录**里准备 Python 依赖和模型。

## 本地市场目录

`market-entry.json` 是一份可合并的示例，仓库地址已经写成 `luczhang88-lang/dsh-meeting-recorder`。要不要把它放进自己的 dsh-market 目录，由维护那个目录的人决定。本仓库不写入任何本机市场文件，也没有 npm 发布步骤。

若以后单独完成 `npm publish`，再把 `versions[0].source` 改成 npm 来源。当前 source 是 GitHub。

## English

Topics are discovery labels, not an automatic market index. `market-entry.json` is a sample record for a catalog you maintain yourself. This repository does not publish the package to npm.
