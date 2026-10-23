#!/usr/bin/env node
'use strict';
/**
 * 从权威分片中移除生成字段。
 *
 * ## 为什么会有这个脚本
 *
 * `scripts/shard_data.js`（已删除）把 index.json 切成「摘要索引 + 每实体分片」，
 * 然后**用摘要覆盖了 index.json**。它不可重入：第二次运行读到的是摘要，
 * 于是把摘要当成实体写进分片。结果 5269 个分片：
 *
 *   - 丢了 props / relations / claims（只剩 id/name/tags）
 *   - 带上了 `detail` —— 这是 `build_index.js` 生成索引时才算出来的指针字段
 *
 * `detail` 出现在分片里是「数据从索引倒灌回来」的确凿证据：它在权威存储里
 * 没有任何意义，只属于索引行。数据内容本身由 `npm run import-cbdb` 重建，
 * 本脚本只负责把不该在分片里的字段清掉。
 *
 * ## 为什么不是直接改 upsertAll
 *
 * 合并函数遇到 `prev` 有 `detail`、`rec` 没有时，`Object.assign({}, rec, prev)`
 * 会让 `detail` 留下来。让合并函数「知道哪些字段是生成物」会把数据模型的
 * 知识塞进通用写入口；更干净的做法是：写入层不管，由本脚本清理一次，
 * 再由 `validate_data.js` 硬性禁止它再出现。
 *
 * 用法：
 *   node tools/oneoff/strip_generated_fields.js --dry-run
 *   node tools/oneoff/strip_generated_fields.js
 */
const path = require('path');
const { readAll, shardPath, FOLDERS } = require('../../src/store/entity_writer');

/** 只允许出现在索引行里的字段。 */
const GENERATED_FIELDS = ['detail'];

const DRY_RUN = process.argv.includes('--dry-run');

function main() {
  const fs = require('fs');
  let scanned = 0;
  let changed = 0;

  for (const [type, folder] of Object.entries(FOLDERS)) {
    const entities = readAll(type);
    scanned += entities.length;
    let touched = 0;

    for (const entity of entities) {
      const present = GENERATED_FIELDS.filter((f) => f in entity);
      if (!present.length) continue;

      for (const f of present) delete entity[f];
      touched++;

      if (!DRY_RUN) {
        const file = shardPath(type, entity.id);
        fs.writeFileSync(file, JSON.stringify(entity, null, 2) + '\n', 'utf8');
      }
    }

    if (touched) {
      changed += touched;
      console.log(`${folder}: ${touched}/${entities.length} 个实体移除生成字段`);
    } else {
      console.log(`${folder}: ${entities.length} 个实体，无需改动`);
    }
  }

  console.log(`\n扫描 ${scanned} 个实体，${changed} 个被清理`);
  if (DRY_RUN) console.log('--dry-run：未写入');
}

main();
