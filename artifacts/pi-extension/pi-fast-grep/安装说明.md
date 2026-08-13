# pi-fast-grep 安装说明

此目录已经包含编译后的扩展和当前 Mac（Apple 芯片）所需的原生搜索组件，不需要运行 npm 或 Cargo。

## 安装（推荐：全局安装一次，所有项目都生效）

```sh
git clone https://github.com/Owen718/snapgrep.git
cd snapgrep

mkdir -p ~/.pi/agent/extensions
cp -R artifacts/pi-extension/pi-fast-grep ~/.pi/agent/extensions/

pi
```

装完就能用。不编译、不启动后台进程、不改你的 shell 配置——产物里已经带了编译好的原生组件。

## 只装到单个项目

```sh
git clone https://github.com/Owen718/snapgrep.git

mkdir -p /path/to/你的项目/.pi/extensions
cp -R snapgrep/artifacts/pi-extension/pi-fast-grep /path/to/你的项目/.pi/extensions/

cd /path/to/你的项目
pi --approve
```

`--approve` 只在项目级扩展尚未受信任时需要一次。产物内的 `.gitignore` 只覆盖这个扩展目录，因此复制安装不会把宿主仓库变成 dirty，也不会影响项目其他文件。

## 配合 oh-my-pi（omp）使用

[oh-my-pi](https://github.com/can1357/oh-my-pi) 带了一个兼容层，把 `@earendil-works/pi-coding-agent` 当作别名包处理，它的扩展加载器也同时接受 `.omp` 和 `.pi` 两种目录。所以同一份产物不用改动：

```sh
git clone https://github.com/Owen718/snapgrep.git
cd snapgrep

mkdir -p ~/.pi/agent/extensions
cp -R artifacts/pi-extension/pi-fast-grep ~/.pi/agent/extensions/

omp
```

这个扩展用到的每一个接口在 omp 的兼容层里都有：`defineTool`、`createGrepToolDefinition`、`registerTool`、`registerFlag`、`getFlag`，以及驱动索引失效与恢复的 `session_start`、`tool_execution_start`、`user_bash`、`tool_result`、`session_shutdown` 五个事件。

需要说明的是，以上是对照 `@oh-my-pi/pi-coding-agent` 已发布的类型定义逐项核对的结果，**没有实际运行验证**。如果实际使用中出现问题，欢迎提 issue。

omp 自带的 grep 也很快，但快的原因不同：它把 ripgrep 链接进自己的进程，省掉了启动子进程的开销，单次大约 6 毫秒。这个收益是真实的，但扫描本身没有变——无论在不在进程内，ripgrep 都要读完每个文件的每个字节。本扩展省掉的是扫描：在 17 MB 的仓库上，ripgrep 用 147.7 毫秒，其中约 6 毫秒是启动；索引用 2.1 毫秒，因为它根本不打开其余 99% 的文件。两种做法是叠加关系，不是替代关系。

## 立即确认

进入安装了扩展的项目，执行：

```sh
pi --approve --help | grep "packaged kernel"
```

看到包含 `packaged kernel` 的搜索后端说明，表示 Pi 已经加载扩展。随后让 Pi“用 grep 搜索一个仓库中确定存在的字符串”；工具详情里的 `actualBackend` 为 `kernel` 时，表示索引搜索已生效。

## 改文件之后会怎样

Pi 开始执行 `edit`、`write`、`bash` 或其他可能改文件的工具前，扩展会先停用旧索引，避免搜索与写入并发时读到一半新、一半旧的内容。工具结束后会在会话内重建当前工作区索引；紧接着的搜索会等待这次重建，成功后重新显示 `actualBackend: kernel`，并能看到刚才的改动。连续修改多次也会逐次恢复，不需要重启 Pi。

恢复时间取决于仓库大小。在随产物最终验收的 300 文件小仓库中，两次 `edit` 和一次 `bash` 后都在约 41–62 毫秒内恢复。大仓库会更久；如果重建失败或遇到扩展无法证明安全的情况，搜索会完整退回 ripgrep，工具详情显示 `actualBackend: rg_fallback` 和原因，结果不会被当成空集。

## 查询范围与自动回退

长度至少 3 字节的纯 ASCII literal 搜索，以及它与规范仓库相对 path（例如 `src`，不要写成 `./src`）、受支持的 gitignore 风格 glob、ASCII ignore-case 的组合，会在安全时走 kernel；不带 path/glob/ignore-case 的已支持正则也可走 kernel。正则与这些过滤器的组合、过短或跨行 literal、含非 ASCII pattern 的 ignore-case、超出已支持子集的 glob，以及命中 binary/NUL 或 Unicode case-fold 风险的查询会自动执行完整 ripgrep，并在工具详情中标为 `rg_fallback` 和具体原因。回退是完整搜索，不会把不支持的查询当成空结果。

扩展用 Pi 的工具执行边界来保护索引，因此应保持默认的隔离加载方式；来自 Pi 之外、且没有经过扩展通知的并发写入不属于这条会话恢复保证。正常的 Pi coding 工作流（搜索、`edit`/`write`/`bash`、再搜索）已做真实端到端验证。

当前产物只包含 `darwin-arm64` 原生组件。如果在其他平台或架构启动，扩展会明确列出缺少的文件和查找路径，不会静默使用错误组件。
