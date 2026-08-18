'use strict'

/**
 * 包根入口（main）。
 * pnpm 在 github:/codeload tarball 安装时会对其 packlist 输出的 main 文件做"压扁到包根"
 * 处理（.npmignore / files 字段存在时触发）；把 main 放在包根使该行为成为恒等操作，
 * lib/ 下的真实实现永不被移动或丢弃。真实实现见 ./lib/index.js。
 */
module.exports = require('./lib/index.js')
