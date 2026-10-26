#!/usr/bin/env node
'use strict';

// Read-only comparison of the known installed application files.
// Does not read .env, call Bitrix24, change Git, or restart services.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(process.argv[2] || process.cwd());
const expected = {
  'server.js': '802679f82e6f51f04650fc57e630bef5ca93c9e8a567175b52e3585d716c2dc9',
  'event-register.html': '3d65bae8256440fb32171ba05e38bdbae182847bbfcd471704461429a7429cd6',
  'lib/bitrix-event-api.js': 'ea535925e9ff3f86cdca5259c4ea784d2f67a194750dde0ce68937437e7da7f3',
  'lib/bitrix-spravka.js': '35403b8f798257434a3b4c756ca15881eba2b532295e3695e1fe10769c2d0ac4',
  'spravka.html': 'd6d5a1c2a519bdbb76009cbe144eaa87c549f4d3405a52c1ad6759a42cd1c656',
  'assets/fonts/GolosText.ttf': '17bb58fb69aec2dfb047a2ebf52534023e9b688c97a6b7ac795b0a72912c2063',
  'assets/fonts/OFL.txt': 'ff532f9e8789f09a9fdffc3c0954eedfb0a48be77b2e2eb90f5f82e4f347f50c',
  'test/spravka.test.js': 'ada513043f69526bea87ef481584937347bc8b8bbd96efb5376ef430ace94d5a',
  'test/spravka-routes.test.js': '330cc390525bfab381c254f030d4038928e36707e3038059ae3841596da3524e'
};
let mismatch = 0;
console.log('Проверка версии справки с ID паспорта и скалярным фильтром сделок');
console.log('Каталог:', root);
for (const [relative, hash] of Object.entries(expected)) {
  try {
    const bytes = fs.readFileSync(path.join(root, relative));
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    const matches = actual === hash;
    console.log(`${matches ? 'OK' : 'ОТЛИЧАЕТСЯ'} | ${relative}`);
    if (!matches) mismatch++;
  } catch {
    console.log(`НЕ ПРОЧИТАН | ${relative}`);
    mismatch++;
  }
}
console.log(mismatch ? `Требуется сверка: ${mismatch} файл(ов). Ничего не изменено.` :
  `Все ${Object.keys(expected).length} файлов совпадают. Ничего не изменено.`);
process.exitCode = mismatch ? 1 : 0;
