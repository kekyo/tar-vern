# tar-vern

tarアーカイブを生成・展開する、TypeScript/JavaScript向けのライブラリ

![tar-vern](../../images/tar-vern-120-c.png)

[![Project Status: Active](https://www.repostatus.org/badges/latest/active.svg)](https://www.repostatus.org/#active)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/tar-vern.svg)](https://www.npmjs.com/package/tar-vern)

---

[(English language is here)](./README.md)

## これは何?

tar-vernは、tarアーカイブを生成・展開する、TypeScript/JavaScript向けのライブラリです。

連続エンコード・デコードに対応し、現代的なAPIを採用しています。
ブラウザ環境とNode.jsの両方に対応しています。

## インストールと対応環境

```sh
npm install tar-vern
```

Node.jsで使用する場合は20.0.0以上が必要です。

ブラウザでは、`ReadableStream`、`WritableStream`、`AbortController`、`AbortSignal.throwIfAborted()`、`TextEncoder`、`TextDecoder`、`DOMException`を使います。
`File`・`Blob`からの入力には`Blob.stream()`、gzipの生成・展開にはそれぞれ`CompressionStream('gzip')`・`DecompressionStream('gzip')`が必要です。

以下に参照する例を示します:

```typescript
import { createTarPacker } from 'tar-vern';
import { storeReaderToFile } from 'tar-vern/node';
```

```javascript
const { createTarPacker } = require('tar-vern');
const { storeReaderToFile } = require('tar-vern/node');
```

共通APIは`tar-vern`、ファイルシステムを扱うNode.js専用APIは`tar-vern/node`から読み込みます。

共通APIとその型定義はNode.jsのモジュールや`Buffer`に依存せず、ブラウザ向けのNode.jsポリフィルは不要です。
ESMとCommonJSの両方に対応しています。

> 2.0.0で変更: ファイルシステム用の関数と`ReflectStats`型を`tar-vern/node`へ移しました。

## 生成と展開の基本

アーカイブ内のファイルやディレクトリーを「エントリー」と呼びます。
非同期ジェネレーターでエントリーを渡すと、`createTarPacker`がその順序でtarのバイト列を出力します。
`createTarExtractor`はバイト列を受け取り、エントリーを順番に返します。

```typescript
import {
  createDirectoryItem,
  createFileItem,
  createTarPacker,
  createTarExtractor,
} from 'tar-vern';

const entries = async function* () {
  yield await createDirectoryItem('messages');
  yield await createFileItem('messages/hello.txt', 'Hello, world!');
};

const archive = createTarPacker(entries());
for await (const entry of createTarExtractor(archive)) {
  if (entry.kind === 'file') {
    console.log(entry.path, await entry.getContent('string'));
  }
}
```

この例の`getContent('string')`はファイル全体をメモリに読み込みます。
大きなファイルの内容は後述の`getContent('readable')`で逐次処理できます。

> 2.0.0で変更: `createTarPacker`の戻り値は`ReadableStream<Uint8Array>`です。Node.jsの`Readable`を前提とするコードでは、`Readable.fromWeb()`で変換します。

## ブラウザのFile・Blobから生成する

ファイル選択で得た`File`にはサイズが含まれています。
`createBlobFileItem`は`File.size`・`Blob.size`を使うため、サイズを調べるために内容を全量収集しません。

```typescript
import { createBlobFileItem, createTarPacker } from 'tar-vern';

const packFiles = async (
  files: Iterable<File>,
  destination: WritableStream<Uint8Array>,
  signal?: AbortSignal
) => {
  const entries = async function* () {
    for (const file of files) {
      yield await createBlobFileItem(file.name, file, undefined, signal);
    }
  };
  await createTarPacker(entries(), 'none', signal).pipeTo(destination, { signal });
};
```

`files`には`<input type="file" multiple>`の`files`などを渡します。
`destination`は利用側が用意する保存先や処理先のWeb Streamです。
アーカイブ内のパスは第1引数で明示し、`File.name`からの自動補完は行いません。
`File`の日時には`lastModified`を使い、`options.date`で上書きできます。
通常の`Blob`の日時は作成時点の現在日時です。

`createReadableFileItem(file.name, file.stream(), { length: file.size, date: new Date(file.lastModified) })`でも同じサイズと日時を渡せます。
`Blob`へ出力全体を集めてからダウンロードする場合は、その全体を保持するメモリが必要です。

## サイズとメモリの扱い

アーカイブ全体のサイズは、生成・展開とも事前に分かっている必要はありません。
ただし、tarは各ファイルのヘッダーを内容より先に書くため、生成時には個々のファイルの正確なバイト数が必要です。

| 入力・取得方法 | メモリの扱い |
| --- | --- |
| `createBlobFileItem`、`length`指定のストリーム・非同期イテラブル | 内容全体を収集せずに生成します |
| `length`を省略した`createReadableFileItem`・`createGeneratorFileItem` | 関数が完了する前に内容全体を収集し、サイズを確定します |
| `createFileItem`の文字列・バイト列 | 呼び出し側が既に保持している内容を使います |
| `getContent('readable')` | ファイル内容を逐次読み出します |
| `getContent('bytes')`・`getContent('string')` | ファイル内容全体を収集します |
| 出力を`Blob`・`ArrayBuffer`へ集約 | アーカイブ全体を収集します |

既知サイズの入力とストリーム出力を組み合わせると、出力の読み取りに合わせて入力が進みます。
出力を読む速度が落ちると入力も停止する仕組みを、バックプレッシャーと呼びます。ストリームやgzipによる有限の先読みはあります。
使用メモリはチャンクの大きさ、入力元のバッファー、出力先の保持量にも依存するため、一定のバイト数を保証するものではありません。

`length`は0以上8,589,934,591以下の整数で指定します。
0バイトのファイルには`length: 0`を渡せます。実際の内容が指定値より多い場合も少ない場合も、生成ストリームがエラーになります。
未知サイズの入力を一時ファイルへ保存したり、二度読みしたり、ヘッダーを後から書き直したりする機能はありません。

> 2.0.0で変更: `length`の不正な値と、実際のバイト数との不一致をエラーにします。

## 共通API

### アーカイブ

| 関数 | 引数と戻り値 |
| --- | --- |
| `createTarPacker(entries, compressionType?, signal?)` | `AsyncIterable<EntryItem>`を受け取り、`ReadableStream<Uint8Array>`を返します |
| `createTarExtractor(source, compressionType?, signal?)` | `ReadableStream<Uint8Array>`または`AsyncIterable<Uint8Array>`を受け取り、`AsyncGenerator<ExtractedEntryItem, void, unknown>`を返します |

`CompressionTypes`は`'none' | 'gzip'`で、省略時は`'none'`です。
形式の自動判定は行いません。`signal`には任意の`AbortSignal`を渡せます。

### エントリーの作成

以下の関数はいずれも`Promise`を返します。`path`はアーカイブ内のパスです。
`options`と`signal`は省略できます。

| 関数 | 内容 | 戻り値 |
| --- | --- | --- |
| `createDirectoryItem(path, options?, signal?)` | 明示したメタデータでディレクトリーを作成 | `Promise<DirectoryItem>` |
| `createFileItem(path, content, options?, signal?)` | `string`または`Uint8Array` | `Promise<FileItem>` |
| `createReadableFileItem(path, readable, options?, signal?)` | `ReadableStream<Uint8Array>` | `Promise<FileItem>` |
| `createGeneratorFileItem(path, generator, options?, signal?)` | `AsyncIterable<Uint8Array>` | `Promise<FileItem>` |
| `createBlobFileItem(path, blob, options?, signal?)` | `Blob`または`File` | `Promise<FileItem>` |

`createDirectoryItem`はファイルシステムを参照しません。
`createReadableFileItem`と`createGeneratorFileItem`の`options`にはメタデータに加えて`length`を指定できます。
その他の作成関数の`options`は`CreateItemOptions`です。

> 2.0.0で変更: バイト列の公開型は`Uint8Array`、`readable`はWeb Streamsを使います。Node.jsの`Buffer`は`Uint8Array`として入力できます。返却値では`Buffer`固有のAPIを前提にしないでください。

### メタデータと公開型

`CreateItemOptions`の各項目は省略可能です。
ファイルとディレクトリーの両方に指定でき、明示した値を優先します。

| 項目 | 型 | 通常の既定値 |
| --- | --- | --- |
| `mode` | `number` | ファイルは`0o644`、ディレクトリーは`0o755` |
| `uid`・`gid` | `number` | `0` |
| `uname`・`gname` | `string` | `'root'` |
| `date` | `Date` | 現在日時。`File`は`lastModified` |

日時はtarへ秒単位で保存します。
`CreateReadableFileItemOptions`は`CreateItemOptions`に省略可能な`length: number`を加えた型です。

`EntryItemBase`は`kind`、`path`と上記メタデータを持ちます。
`EntryItem`は`FileItem | DirectoryItem`です。`FileItem.content`には文字列、`Uint8Array`、または次の`EntryItemContent`を指定できます。

```typescript
type EntryItemContent =
  | { kind: 'readable'; length: number; readable: ReadableStream<Uint8Array> }
  | { kind: 'generator'; length: number; generator: AsyncIterable<Uint8Array> };
```

各形式の公開型は`EntryItemReadableContent`と`EntryItemGeneratorContent`で、共通の`kind`・`length`を`EntryItemContentBase`に定義しています。
展開側の`ExtractedEntryItem`は`ExtractedFileItem | ExtractedDirectoryItem`です。どちらもメタデータを持ち、ファイルには`getContent`があります。

## 展開したファイルの内容を読む

`getContent`はエントリーごとに一度だけ呼び出せます。

| 呼び出し | 戻り値 |
| --- | --- |
| `await entry.getContent('string')` | UTF-8として復号した`string` |
| `await entry.getContent('bytes')` | `Uint8Array` |
| `await entry.getContent('readable')` | `ReadableStream<Uint8Array>` |

> 2.0.0で変更: `getContent('buffer')`は`getContent('bytes')`へ置き換えます。Node.jsで`Buffer`が必要なら`Buffer.from(bytes)`で変換できます。

```typescript
import { createTarExtractor } from 'tar-vern';

const countFileBytes = async (source: ReadableStream<Uint8Array>) => {
  for await (const entry of createTarExtractor(source)) {
    if (entry.kind !== 'file') continue;
    let size = 0;
    await (await entry.getContent('readable')).pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.length;
        },
      })
    );
    console.log(entry.path, size);
  }
};
```

内容を取得しないまま次のエントリーへ進むと、そのファイルは読み飛ばされます。
ストリームを取得した場合は、読み切るかキャンセルしてから次へ進めてください。
取得したストリームが未完了のまま親の列挙を進めるとエラーになります。
途中まで読んで不要になった場合は`await reader.cancel()`で内容をキャンセルし、`reader.releaseLock()`でロックを解放します。
次のエントリーへ進む際に残りの内容が読み飛ばされます。

> 2.0.0で変更: 取得済みの内容ストリームと親のエントリー列挙を同時に進める使い方をエラーにします。

## キャンセルとエラー

生成・展開や作成関数には`AbortSignal`を渡せます。
対応する`AbortController.abort()`を呼ぶと、読み取り待ちの処理も中断します。
生成ストリームの`cancel()`や、展開の`for await`からの`break`も入力の終了処理につながります。
ファイル内容だけのキャンセルでは、アーカイブの次のエントリーへ進めます。

既知サイズの`createReadableFileItem`・`createGeneratorFileItem`・`createBlobFileItem`は、作成時にsignalの状態を確認します。
その後の生成を中断するには、例のように`createTarPacker`にも同じsignalを渡してください。

独自の非同期イテラブルを使う場合、tar-vernは終了時にその`return()`を要求しますが、イテラブル内部で実行中の外部処理を強制停止することはできません。
その処理にも必要なキャンセル対応を実装してください。

入力エラー、サイズ不一致、tarのヘッダーやチェックサムの異常、gzipのエラーは、ストリームの読み取りや列挙を失敗させます。
最後のファイルが見つかっただけでは成功と判断せず、ストリームまたは列挙が正常に終了するまで待ってください。
tar終端の後に届くgzipの末尾エラーや入力エラーも伝わります。

## gzip

生成・展開の第2引数へ`'gzip'`を渡すと、標準の圧縮ストリームAPIを使います。
必要なAPIがない環境では明示的にエラーとなり、非圧縮へ自動的に切り替わることはありません。
`'none'`はgzip用APIがなくても利用できます。

> 2.0.0で変更: Node.jsのzlibで圧縮レベル9を指定する実装を廃止しました。標準APIにはレベル指定がないため、圧縮率や圧縮済みバイト列は実行環境によって異なります。[CompressionStream仕様](https://compression.spec.whatwg.org/#compressionstream)

対応範囲は単一メンバーのgzipです。
メンバーとはgzip形式の独立した圧縮データ1個を指します。
複数メンバーの連結は対応範囲外で、拒否されるかどうかは実行環境に依存します。
標準仕様は連結メンバーを拒否しますが、Node.js v24.15.0では受理されることを確認しています。
全環境での拒否は保証しません。
[gzip仕様](https://compression.spec.whatwg.org/#gzip)、[Node.js v24.15.0の圧縮ストリーム実装](https://github.com/nodejs/node/blob/v24.15.0/lib/internal/webstreams/compression.js)

## Node.jsのファイルシステムAPI

```typescript
import { createReadStream } from 'node:fs';
import { createTarPacker, createTarExtractor } from 'tar-vern';
import {
  createEntryItemGenerator,
  storeReaderToFile,
  extractTo,
} from 'tar-vern/node';

await storeReaderToFile(
  createTarPacker(createEntryItemGenerator('./input'), 'gzip'),
  './archive.tar.gz'
);

await extractTo(
  createTarExtractor(createReadStream('./archive.tar.gz'), 'gzip'),
  './output'
);
```

| 関数 | 動作 |
| --- | --- |
| `createReadFileItem(path, filePath, reflectStat?, options?, signal?)` | 実ファイルのサイズを使って`Promise<FileItem>`を返します。内容は生成時に読み出します |
| `createReadDirectoryItem(path, directoryPath, reflectStat?, options?, signal?)` | 実ディレクトリーのメタデータを使って`Promise<DirectoryItem>`を返します |
| `createEntryItemGenerator(baseDir, relativePaths?, includeDirectory?, reflectStat?, signal?)` | `AsyncGenerator<EntryItem, void, unknown>`を返します。`relativePaths`省略時は再帰的に列挙し、`includeDirectory`の既定値は`true`です |
| `storeReaderToFile(source, path, signal?)` | Web Streamまたは非同期のバイト列をファイルへ保存し、完了を`Promise<void>`で返します |
| `extractTo(entries, basePath, signal?)` | 展開エントリーを逐次ファイルへ保存し、完了を`Promise<void>`で返します |

`relativePaths`を指定すると、その配列の順に処理します。アクセスできないパスは警告して読み飛ばします。`ReflectStats`は、ファイルシステムの情報をエントリーへ反映する範囲を指定する型です。

| 値 | 動作 |
| --- | --- |
| `'exceptName'`（既定値） | `mode`・`uid`・`gid`・更新日時を反映し、名前は通常の既定値を使います |
| `'all'` | 上記に加え、`uid`・`gid`を文字列にして`uname`・`gname`へ設定します。OSのアカウント名を検索するものではありません |
| `'none'` | 任意のメタデータは反映しません。ファイルのサイズは引き続き取得します |

`options`の明示値がファイルシステム由来の値より優先されます。
`createReadDirectoryItem`で`'none'`を選んだ場合は、ディレクトリーのstatを取得しません。

> 2.0.0で変更: `createDirectoryItem`で実ディレクトリーのstatを反映する使い方は、新設の`createReadDirectoryItem`へ移しました。

`extractTo`はファイルやディレクトリーの作成時に`mode`を渡します。
`uid`・`gid`・日時をOSへ再適用する処理は行いません。
`storeReaderToFile`は失敗やキャンセル時に、作成途中のファイルを残す場合があります。

> 2.0.0で変更: `extractTo`は内容全体を収集せず保存先へ逐次書き込みます。失敗やキャンセル時に書き込み済みの部分が残る場合があります。

Node.jsのバイナリー`Readable`は`AsyncIterable<Uint8Array>`として入力できます。
Web StreamをNode.jsの既存パイプラインへ渡す場合は`Readable.fromWeb()`、Node.jsストリームを`createReadableFileItem`へ渡す場合は`Readable.toWeb()`で変換します。
これらの変換APIはNode.js 22.17.0で安定版になりました。
[Node.js Stream API](https://nodejs.org/api/stream.html#streamreadablefromwebreadablestream-options)

## tar形式の範囲

通常のファイルとディレクトリーをustar形式で扱います。
ファイル内容の文字列と名前はUTF-8です。
PAX拡張やシンボリックリンクなどを扱うためのAPIはありません。

パスのname欄は100バイト、prefix欄は155バイトです。
現在の実装は収まらない部分をUTF-8の文字境界で切り詰めるため、長いパスは完全には保持されません。
`uname`・`gname`もそれぞれ32バイトまでです。

## 利用例を動かす

リポジトリーを取得した環境では、次のコマンドでブラウザのファイル選択、逐次カウント、ダウンロード、展開を試せます。

```sh
npm ci
npm run build
npm run example:browser
```

Node.jsの最小例はビルド後に`node examples/node.mjs`で実行できます。
[ブラウザの例](../../examples/browser/main.ts)と[Node.jsの例](../../examples/node.mjs)も参照してください。

## ライセンス

Under MIT.
