# Switch 游戏文件管理器

一款基于 Electron 的 Nintendo Switch 游戏文件管理工具，支持自动解压、整理和传输游戏文件。

## 功能

- **游戏扫描** — 自动识别源文件夹中的游戏文件（NSP/NSZ/XCI/XCZ）和压缩包（RAR/ZIP）
- **智能解压** — 支持密码重试、多分卷 RAR、嵌套压缩包的两阶段解压
- **文件夹整理** — 一键将混乱的数字文件夹重命名为游戏名，归类散落文件，清理垃圾
- **TitleDB 集成** — 自动查询游戏名称、封面图和发行商信息
- **MTP 设备支持** — 直接传输游戏文件到 Switch SD 卡（通过 USB 连接）

## 截图

![主界面](assets/screenshot.png)

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [7-Zip](https://www.7-zip.org/)（解压功能需要）

### 安装与运行

```bash
git clone https://github.com/quake0day/switch-game-manager.git
cd switch-game-manager
npm install
npm start
```

### 打包

```bash
npm run build
```

生成便携版 exe 位于 `dist/Switch游戏管理器.exe`。

## 使用方法

1. 打开应用，点击右上角 ⚙ 进入设置
2. 添加**源文件夹**（游戏压缩包所在目录）
3. 设置**目标文件夹**（解压后的游戏文件输出位置）
4. 点击**更新数据库**下载 TitleDB（用于显示游戏名称和封面）
5. 返回主界面，点击**扫描游戏**
6. 选择要处理的游戏，点击**处理选中**

### 文件夹整理

点击工具栏的**整理文件夹**按钮，可以：

| 操作 | 说明 |
|------|------|
| 重命名 | 数字文件夹 → `游戏名 [TitleID]/` |
| 嵌套整理 | `X/X/内容` → `游戏名 [TitleID]/内容` |
| 移入ZIP | 散落的压缩包归入对应游戏文件夹 |
| 移入文件 | 散落的游戏文件按 Title ID 分组归入文件夹 |
| 清理 | 删除 `.tmp`、`.DS_Store` 等垃圾文件 |

所有操作会先预览，确认后再执行。

## 技术栈

- **Electron** — 桌面应用框架
- **Node.js** — 文件操作与 7-Zip 调用
- **TitleDB** — [blawar/titledb](https://github.com/blawar/titledb) 游戏数据库

## License

MIT
