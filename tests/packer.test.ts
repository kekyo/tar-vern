// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync } from 'fs';
import { spawn } from 'child_process';
import { createGzip } from 'zlib';
import dayjs from 'dayjs';
import { createTarPacker } from '../src/packer';
import { CompressionTypes, EntryItem } from '../src/types';
import { createReadableFileItem, createReadFileItem, createDirectoryItem, storeReaderToFile } from '../src/utils';

describe('Tar packer test', () => {
  const tempBaseDir = join(tmpdir(), 'tar-vern-test', 'packer', dayjs().format('YYYYMMDD_HHmmssSSS'));

  let testDir: string;

  beforeEach(fn => {
    testDir = join(tempBaseDir, fn.task.name);
    mkdirSync(testDir, { recursive: true });
  });

  const runCommand = (command: string, args: string[], env: Record<string, string> = {}) => {
    const task = spawn(command, args, { env: { ...process.env, ...env } });
    let output = '';
    task.stdout.on('data', (data) => {
      output += data.toString();
    });
    task.stderr.on('data', (data) => {
      output += data.toString();
    });
    return new Promise<string>((res, rej) => {
      task.on('close', code => {
        if (code === 0) {
          res(output);
        } else {
          rej(new Error(`${command} process exited with code ${code}: ${output}`));
        }
      });
    });
  }

  const extractTar = (tarPath: string, storeToPath: string) => {
    mkdirSync(storeToPath, { recursive: true });
    return runCommand('tar', ['-xvf', tarPath, '-C', storeToPath]);
  }

  const extractTarGzip = (tarPath: string, storeToPath: string) => {
    mkdirSync(storeToPath, { recursive: true });
    return runCommand('tar', ['-zxvf', tarPath, '-C', storeToPath]);
  }

  const storeReaderToGzipFile = (reader: Readable, path: string) => {
    const gzip = createGzip();
    const writer = createWriteStream(path);
    reader.pipe(gzip).pipe(writer);
    return new Promise<void>((res, rej) => {
      writer.on('finish', res);
      writer.on('error', rej);
      gzip.on('error', rej);
    });
  }

  it('should store a string into a tar stream', async () => {
    // Create a generator function that returns an test entry item
    const generator = async function*() {
      // A 'test.txt' file
      const item: EntryItem = {
        kind: 'file',
        path: 'test.txt',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: 'Hello, world!',   // String content
      }
      yield item;
    };
    const packer = createTarPacker(generator());

    // Store packer stream into a temporary file and wait for it to finish
    const tarPath = join(testDir, 'test.tar');
    await storeReaderToFile(packer, tarPath);

    // Read the temporary tar file by spawned tar command
    const extractedDir = join(testDir, 'extracted');
    await extractTar(tarPath, extractedDir);

    // Check the extracted file
    const extractedFilePath = join(extractedDir, 'test.txt');
    const extractedFileContent = readFileSync(extractedFilePath, 'utf8');
    expect(extractedFileContent).toBe('Hello, world!');
  });

  it('should create directory entries', async () => {
    const generator = async function*() {
      const dirItem: EntryItem = {
        kind: 'directory',
        path: 'test-dir',
        mode: 0o755,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
      }
      yield dirItem;
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'dir-test.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'dir-extracted');
    await extractTar(tarPath, extractedDir);

    // Check the extracted directory exists
    const extractedDirPath = join(extractedDir, 'test-dir');
    expect(require('fs').existsSync(extractedDirPath)).toBe(true);
    expect(require('fs').statSync(extractedDirPath).isDirectory()).toBe(true);
  });

  it('should store files in directories', async () => {
    const generator = async function*() {
      // Create directory first
      yield {
        kind: 'directory' as const,
        path: 'my-dir',
        mode: 0o755,
        uname: 'user',
        gname: 'group',
        uid: 1001,
        gid: 1001,
        date: new Date(),
      };
      
      // Then file inside directory
      yield {
        kind: 'file' as const,
        path: 'my-dir/nested-file.txt',
        mode: 0o644,
        uname: 'user',
        gname: 'group',
        uid: 1001,
        gid: 1001,
        date: new Date(),
        content: 'Nested file content',
      };
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'nested-test.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'nested-extracted');
    await extractTar(tarPath, extractedDir);

    // Check directory exists
    const dirPath = join(extractedDir, 'my-dir');
    expect(require('fs').existsSync(dirPath)).toBe(true);
    expect(require('fs').statSync(dirPath).isDirectory()).toBe(true);

    // Check file exists and has correct content
    const filePath = join(extractedDir, 'my-dir', 'nested-file.txt');
    expect(require('fs').existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf8');
    expect(content).toBe('Nested file content');
  });

  it('should handle multiple files', async () => {
    const generator = async function*() {
      const files = [
        { name: 'file1.txt', content: 'First file content' },
        { name: 'file2.txt', content: 'Second file content' },
        { name: 'file3.txt', content: 'Third file content' }
      ];

      for (const file of files) {
        yield {
          kind: 'file' as const,
          path: file.name,
          mode: 0o644,
          uname: 'test',
          gname: 'test',
          uid: 0,
          gid: 0,
          date: new Date(),
          content: file.content,
        };
      }
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'multi-files.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'multi-extracted');
    await extractTar(tarPath, extractedDir);

    // Check all files exist with correct content
    const file1Content = readFileSync(join(extractedDir, 'file1.txt'), 'utf8');
    const file2Content = readFileSync(join(extractedDir, 'file2.txt'), 'utf8');
    const file3Content = readFileSync(join(extractedDir, 'file3.txt'), 'utf8');

    expect(file1Content).toBe('First file content');
    expect(file2Content).toBe('Second file content');
    expect(file3Content).toBe('Third file content');
  });

  it('should preserve different file modes', async () => {
    const generator = async function*() {
      // Executable file
      yield {
        kind: 'file' as const,
        path: 'executable.sh',
        mode: 0o755,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: '#!/bin/bash\necho "Hello"',
      };

      // Read-only file
      yield {
        kind: 'file' as const,
        path: 'readonly.txt',
        mode: 0o444,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: 'Read-only content',
      };

      // Directory with special permissions
      yield {
        kind: 'directory' as const,
        path: 'special-dir',
        mode: 0o750,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
      };
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'modes-test.tar');
    await storeReaderToFile(packer, tarPath);

    // Use tar -tvf to check modes in the archive with UTC timezone
    const listOutput = await runCommand('tar', ['-tvf', tarPath], { TZ: 'UTC' });

    // Check that modes are preserved in the archive
    expect(listOutput).toMatch(/-rwxr-xr-x.*executable\.sh/);
    expect(listOutput).toMatch(/-r--r--r--.*readonly\.txt/);
    expect(listOutput).toMatch(/drwxr-x---.*special-dir/);
  });

  it('should handle large random files with content verification', async () => {
    // Generate two 1MB random files
    const size1MB = 1024 * 1024;
    const randomData1 = Buffer.allocUnsafe(size1MB);
    const randomData2 = Buffer.allocUnsafe(size1MB);
    
    // Fill with different random patterns
    for (let i = 0; i < size1MB; i++) {
      randomData1[i] = Math.floor(Math.random() * 256);
      randomData2[i] = Math.floor(Math.random() * 256);
    }

    const generator = async function*() {
      yield {
        kind: 'file' as const,
        path: 'large1.bin',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: randomData1,
      };

      yield {
        kind: 'file' as const,
        path: 'large2.bin',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: randomData2,
      };
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'large-files.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'large-extracted');
    await extractTar(tarPath, extractedDir);

    // Verify file sizes and content integrity
    const extracted1 = readFileSync(join(extractedDir, 'large1.bin'));
    const extracted2 = readFileSync(join(extractedDir, 'large2.bin'));

    expect(extracted1.length).toBe(size1MB);
    expect(extracted2.length).toBe(size1MB);
    expect(extracted1.equals(randomData1)).toBe(true);
    expect(extracted2.equals(randomData2)).toBe(true);
  });

  it('should preserve metadata (uname/gname/uid/gid/date)', async () => {
    const testDate = new Date('2023-10-15T12:30:45Z');
    
    const generator = async function*() {
      yield {
        kind: 'file' as const,
        path: 'metadata-test.txt',
        mode: 0o644,
        uname: 'alice',
        gname: 'developers',
        uid: 1001,
        gid: 2001,
        date: testDate,
        content: 'Metadata test content',
      };

      yield {
        kind: 'directory' as const,
        path: 'metadata-dir',
        mode: 0o755,
        uname: 'bob',
        gname: 'admins',
        uid: 1002,
        gid: 2002,
        date: testDate,
      };
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'metadata-test.tar');
    await storeReaderToFile(packer, tarPath);

    // Use tar -tvf to check metadata with UTC timezone
    const listOutput = await runCommand('tar', ['-tvf', tarPath], { TZ: 'UTC' });

    // Check that metadata is preserved
    expect(listOutput).toMatch(/alice\/developers.*metadata-test\.txt/);
    expect(listOutput).toMatch(/bob\/admins.*metadata-dir/);
    expect(listOutput).toMatch(/2023-10-15 12:30.*metadata-test\.txt/);
    expect(listOutput).toMatch(/2023-10-15 12:30.*metadata-dir/);
  });

  it('should handle different content types (Buffer, generator, stream)', async () => {
    const testContent = 'Hello from different sources!';
    const bufferContent = Buffer.from(testContent, 'utf8');

    const generator = async function*() {
      // Buffer content
      yield {
        kind: 'file' as const,
        path: 'buffer-file.txt',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: bufferContent,
      };

      // Generator content
      yield {
        kind: 'file' as const,
        path: 'generator-file.txt',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: {
          kind: 'generator' as const,
          length: testContent.length,
          generator: (async function*() {
            // Split content into chunks
            const chunks = [
              Buffer.from('Hello from ', 'utf8'),
              Buffer.from('different ', 'utf8'),
              Buffer.from('sources!', 'utf8')
            ];
            for (const chunk of chunks) {
              yield chunk;
            }
          })()
        },
      };

      // Readable stream content
      yield {
        kind: 'file' as const,
        path: 'stream-file.txt',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: {
          kind: 'readable' as const,
          length: testContent.length,
          readable: Readable.from([testContent])
        },
      };
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'content-types.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'content-extracted');
    await extractTar(tarPath, extractedDir);

    // Verify all files have the same content
    const bufferFileContent = readFileSync(join(extractedDir, 'buffer-file.txt'), 'utf8');
    const generatorFileContent = readFileSync(join(extractedDir, 'generator-file.txt'), 'utf8');
    const streamFileContent = readFileSync(join(extractedDir, 'stream-file.txt'), 'utf8');

    expect(bufferFileContent).toBe(testContent);
    expect(generatorFileContent).toBe(testContent);
    expect(streamFileContent).toBe(testContent);
  });

  it('should work with createReadableItem helper', async () => {
    const testContent = 'Content from readable item helper!';
    const stream = Readable.from([testContent]);
    
    const generator = async function*() {
      const fileItem = await createReadableFileItem('helper-test.txt', stream, {
        mode: 0o644,
        uname: 'helper',
        gname: 'helper',
        uid: 1000,
        gid: 1000,
        date: new Date('2023-11-01T10:00:00Z')
      });
      yield fileItem;
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'helper-readable.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'helper-readable-extracted');
    await extractTar(tarPath, extractedDir);

    const extractedContent = readFileSync(join(extractedDir, 'helper-test.txt'), 'utf8');
    expect(extractedContent).toBe(testContent);
  });

  it('should work with createReadFileItem helper', async () => {
    // Create a test file
    const testFilePath = join(testDir, 'source-file.txt');
    const testContent = 'Content from file helper!';
    writeFileSync(testFilePath, testContent);
    
    const generator = async function*() {
      const fileItem = await createReadFileItem('archived-file.txt', testFilePath, `exceptName`, {
        mode: 0o755,
        uname: 'filehelper',
        gname: 'filehelper',
        uid: 2000,
        gid: 2000,
        date: new Date('2023-11-02T11:00:00Z')
      });
      yield fileItem;
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'helper-file.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'helper-file-extracted');
    await extractTar(tarPath, extractedDir);

    // Verify content
    const extractedContent = readFileSync(join(extractedDir, 'archived-file.txt'), 'utf8');
    expect(extractedContent).toBe(testContent);

    // Verify metadata
    const listOutput = await runCommand('tar', ['-tvf', tarPath], { TZ: 'UTC' });
    expect(listOutput).toMatch(/filehelper\/filehelper.*archived-file\.txt/);
    expect(listOutput).toMatch(/-rwxr-xr-x.*archived-file\.txt/);
    expect(listOutput).toMatch(/2023-11-02 11:00.*archived-file\.txt/);
  });

  it('should auto-reflect file stat information when no options are provided', async () => {
    // Create a test file with specific permissions and modification time
    const testFilePath = join(testDir, 'stat-test-file.txt');
    const testContent = 'Content for stat test!';
    writeFileSync(testFilePath, testContent);
    
    // Set specific permissions (executable)
    chmodSync(testFilePath, 0o755);
    
    // Get the actual stat info to compare against
    const originalStat = statSync(testFilePath);
    
    const generator = async function*() {
      // Call createReadFileItem without any options - should use stat info
      const fileItem = await createReadFileItem('stat-reflected-file.txt', testFilePath);
      yield fileItem;
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'stat-test.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'stat-extracted');
    await extractTar(tarPath, extractedDir);

    // Verify content
    const extractedContent = readFileSync(join(extractedDir, 'stat-reflected-file.txt'), 'utf8');
    expect(extractedContent).toBe(testContent);

    // Use tar -tvf to check that the stat information was preserved
    const listOutput = await runCommand('tar', ['-tvf', tarPath], { TZ: 'UTC' });
    
    // Check that the file mode matches the original file permissions
    expect(listOutput).toMatch(/-rwxr-xr-x.*stat-reflected-file\.txt/);
    
    // Check that file size matches
    expect(listOutput).toMatch(new RegExp(`${originalStat.size}.*stat-reflected-file\\.txt`));
    
    // Parse the tar output to verify uid/gid (basic verification)
    // The format is typically: permissions links owner/group size date filename
    const lines = listOutput.split('\n');
    const fileLine = lines.find(line => line.includes('stat-reflected-file.txt'));
    expect(fileLine).toBeDefined();
    
    // Verify that the mtime in the archive is close to original file mtime
    // (within a reasonable tolerance due to filesystem precision differences)
    const archiveTime = new Date(fileLine!.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)![0] + ':00Z');
    const originalTime = new Date(originalStat.mtime);
    const timeDiff = Math.abs(archiveTime.getTime() - originalTime.getTime());
    expect(timeDiff).toBeLessThan(60000); // Within 1 minute tolerance
  });

  it('should work with createDirectoryItem helper with options', async () => {
    const generator = async function*() {
      const dirItem = await createDirectoryItem('custom-dir', 'none', {
        mode: 0o750,
        uname: 'diruser',
        gname: 'dirgroup',
        uid: 1500,
        gid: 1500,
        date: new Date('2023-12-01T15:30:00Z')
      });
      yield dirItem;
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'directory-helper.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'directory-helper-extracted');
    await extractTar(tarPath, extractedDir);

    // Check directory exists
    const dirPath = join(extractedDir, 'custom-dir');
    expect(require('fs').existsSync(dirPath)).toBe(true);
    expect(require('fs').statSync(dirPath).isDirectory()).toBe(true);

    // Verify metadata using tar -tvf
    const listOutput = await runCommand('tar', ['-tvf', tarPath], { TZ: 'UTC' });
    expect(listOutput).toMatch(/diruser\/dirgroup.*custom-dir/);
    expect(listOutput).toMatch(/drwxr-x---.*custom-dir/);
    expect(listOutput).toMatch(/2023-12-01 15:30.*custom-dir/);
  });

  it('should auto-reflect directory stat information when reflectStat is not none', async () => {
    // Create a test directory with specific permissions
    const testDirPath = join(testDir, 'stat-test-dir');
    mkdirSync(testDirPath, { recursive: true });
    
    // Set specific permissions
    chmodSync(testDirPath, 0o755);
    
    // Get the actual stat info to compare against
    const originalStat = statSync(testDirPath);
    
    const generator = async function*() {
      // Call createDirectoryItem with filesystem path and default reflectStat ('exceptName') - should use stat info
      const dirItem = await createDirectoryItem(testDirPath, 'exceptName');
      // Override the archive path
      const modifiedDirItem = { ...dirItem, path: 'reflected-dir' };
      yield modifiedDirItem;
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'dir-stat-test.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'dir-stat-extracted');
    await extractTar(tarPath, extractedDir);

    // Check directory exists
    const dirPath = join(extractedDir, 'reflected-dir');
    expect(require('fs').existsSync(dirPath)).toBe(true);
    expect(require('fs').statSync(dirPath).isDirectory()).toBe(true);

    // Use tar -tvf to check that the stat information was preserved
    const listOutput = await runCommand('tar', ['-tvf', tarPath], { TZ: 'UTC' });
    
    // Check that the directory mode matches the original directory permissions
    expect(listOutput).toMatch(/drwxr-xr-x.*reflected-dir/);
    
    // Parse the tar output to verify the timestamp
    const lines = listOutput.split('\n');
    const dirLine = lines.find(line => line.includes('reflected-dir'));
    expect(dirLine).toBeDefined();
    
    // Verify that the mtime in the archive is close to original directory mtime
    const archiveTime = new Date(dirLine!.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)![0] + ':00Z');
    const originalTime = new Date(originalStat.mtime);
    const timeDiff = Math.abs(archiveTime.getTime() - originalTime.getTime());
    expect(timeDiff).toBeLessThan(60000); // Within 1 minute tolerance
  });

  it('should not reflect stat information when reflectStat is none', async () => {
    // Create a test directory with specific permissions
    const testDirPath = join(testDir, 'no-stat-test-dir');
    mkdirSync(testDirPath, { recursive: true });
    
    // Set specific permissions that should NOT be reflected
    chmodSync(testDirPath, 0o700);
    
    const generator = async function*() {
      // Call createDirectoryItem with reflectStat 'none' - should use default values
      const dirItem = await createDirectoryItem('no-reflected-dir', 'none');
      yield dirItem;
    };
    const packer = createTarPacker(generator());

    const tarPath = join(testDir, 'dir-no-stat-test.tar');
    await storeReaderToFile(packer, tarPath);

    const extractedDir = join(testDir, 'dir-no-stat-extracted');
    await extractTar(tarPath, extractedDir);

    // Check directory exists
    const dirPath = join(extractedDir, 'no-reflected-dir');
    expect(require('fs').existsSync(dirPath)).toBe(true);
    expect(require('fs').statSync(dirPath).isDirectory()).toBe(true);

    // Use tar -tvf to check that default values were used instead of stat
    const listOutput = await runCommand('tar', ['-tvf', tarPath], { TZ: 'UTC' });
    
    // Check that the directory mode is the default (0o755 = drwxr-xr-x) not the actual file mode (0o700)
    expect(listOutput).toMatch(/drwxr-xr-x.*no-reflected-dir/);
    expect(listOutput).not.toMatch(/drwx------.*no-reflected-dir/);
    
    // Check that default uid/gid are used (should show as root/root or numeric 0/0)
    expect(listOutput).toMatch(/(root\/root|0\/0).*no-reflected-dir/);
  });

  it('should handle large random files compressed with gzip (tgz format)', async () => {
    // Generate two 1MB random files (same structure as existing large file test)
    const size1MB = 1024 * 1024;
    const randomData1 = Buffer.allocUnsafe(size1MB);
    const randomData2 = Buffer.allocUnsafe(size1MB);
    
    // Fill with different random patterns
    for (let i = 0; i < size1MB; i++) {
      randomData1[i] = Math.floor(Math.random() * 256);
      randomData2[i] = Math.floor(Math.random() * 256);
    }

    const generator = async function*() {
      yield {
        kind: 'file' as const,
        path: 'large1.bin',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: randomData1,
      };

      yield {
        kind: 'file' as const,
        path: 'large2.bin',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: randomData2,
      };
    };
    const packer = createTarPacker(generator());

    // Store packer stream compressed with gzip to create a .tgz file
    const tgzPath = join(testDir, 'large-files.tgz');
    await storeReaderToGzipFile(packer, tgzPath);

    // Extract the .tgz file using tar (should auto-detect gzip compression)
    const extractedDir = join(testDir, 'tgz-extracted');
    await extractTar(tgzPath, extractedDir);

    // Verify file sizes and content integrity (same as original test)
    const extracted1 = readFileSync(join(extractedDir, 'large1.bin'));
    const extracted2 = readFileSync(join(extractedDir, 'large2.bin'));

    expect(extracted1.length).toBe(size1MB);
    expect(extracted2.length).toBe(size1MB);
    expect(extracted1.equals(randomData1)).toBe(true);
    expect(extracted2.equals(randomData2)).toBe(true);

  });

  it('should handle CompressionTypes.gzip for built-in compression', async () => {
    // Generate test data similar to the large file test
    const size1MB = 1024 * 1024;
    const randomData1 = Buffer.allocUnsafe(size1MB);
    const randomData2 = Buffer.allocUnsafe(size1MB);
    
    // Fill with different random patterns
    for (let i = 0; i < size1MB; i++) {
      randomData1[i] = Math.floor(Math.random() * 256);
      randomData2[i] = Math.floor(Math.random() * 256);
    }

    const generator = async function*() {
      yield {
        kind: 'file' as const,
        path: 'compressed1.bin',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: randomData1,
      };

      yield {
        kind: 'file' as const,
        path: 'compressed2.bin',
        mode: 0o644,
        uname: 'test',
        gname: 'test',
        uid: 0,
        gid: 0,
        date: new Date(),
        content: randomData2,
      };
    };

    // Use createTarPacker with CompressionTypes.gzip
    const compressionType: CompressionTypes = 'gzip';
    const packer = createTarPacker(generator(), compressionType);

    // Store the compressed packer stream to a .tgz file
    const tgzPath = join(testDir, 'builtin-compressed.tgz');
    await storeReaderToFile(packer, tgzPath);

    // Extract using tar with explicit gzip decompression (-zxvf)
    const extractedDir = join(testDir, 'builtin-compressed-extracted');
    await extractTarGzip(tgzPath, extractedDir);

    // Verify file sizes and content integrity
    const extracted1 = readFileSync(join(extractedDir, 'compressed1.bin'));
    const extracted2 = readFileSync(join(extractedDir, 'compressed2.bin'));

    expect(extracted1.length).toBe(size1MB);
    expect(extracted2.length).toBe(size1MB);
    expect(extracted1.equals(randomData1)).toBe(true);
    expect(extracted2.equals(randomData2)).toBe(true);
  });

  describe('Exception handling in generators', () => {
    it('should handle exception in entry item generator', async () => {
      const generator = async function*() {
        // First item should work
        yield {
          kind: 'file' as const,
          path: 'first.txt',
          mode: 0o644,
          uname: 'test',
          gname: 'test',
          uid: 0,
          gid: 0,
          date: new Date(),
          content: 'First file content',
        };

        // Second item should throw an error
        throw new Error('Generator exception test');
      };

      const packer = createTarPacker(generator());
      const tarPath = join(testDir, 'exception-test.tar');

      // Should reject when trying to store the packer stream
      await expect(storeReaderToFile(packer, tarPath)).rejects.toThrow('Generator exception test');
    });

    it('should handle exception in content generator', async () => {
      const generator = async function*() {
        yield {
          kind: 'file' as const,
          path: 'generator-exception.txt',
          mode: 0o644,
          uname: 'test',
          gname: 'test',
          uid: 0,
          gid: 0,
          date: new Date(),
          content: {
            kind: 'generator' as const,
            length: 100, // Doesn't matter for this test
            generator: (async function*() {
              yield Buffer.from('Some content', 'utf8');
              throw new Error('Content generator exception');
            })()
          },
        };
      };

      const packer = createTarPacker(generator());
      const tarPath = join(testDir, 'content-exception-test.tar');

      // Should reject when content generator throws
      await expect(storeReaderToFile(packer, tarPath)).rejects.toThrow('Content generator exception');
    });

    it('should handle exception in readable stream', async () => {
      const generator = async function*() {
        // Create a readable stream that will error immediately
        const errorStream = new Readable({
          read() {
            // Emit error immediately instead of using nextTick
            this.emit('error', new Error('Readable stream exception'));
          }
        });

        yield {
          kind: 'file' as const,
          path: 'stream-exception.txt',
          mode: 0o644,
          uname: 'test',
          gname: 'test',
          uid: 0,
          gid: 0,
          date: new Date(),
          content: {
            kind: 'readable' as const,
            length: 100,
            readable: errorStream
          },
        };
      };

      const packer = createTarPacker(generator());
      const tarPath = join(testDir, 'stream-exception-test.tar');

      // Should reject when readable stream emits error
      await expect(storeReaderToFile(packer, tarPath)).rejects.toThrow('Readable stream exception');
    });

    it('should handle partial success before exception', async () => {
      const generator = async function*() {
        // First file should be successfully written
        yield {
          kind: 'file' as const,
          path: 'success.txt',
          mode: 0o644,
          uname: 'test',
          gname: 'test',
          uid: 0,
          gid: 0,
          date: new Date(),
          content: 'This should be written successfully',
        };

        // Second file causes exception
        yield {
          kind: 'file' as const,
          path: 'will-fail.txt',
          mode: 0o644,
          uname: 'test',
          gname: 'test',
          uid: 0,
          gid: 0,
          date: new Date(),
          content: {
            kind: 'generator' as const,
            length: 50,
            generator: (async function*() {
              yield Buffer.from('Partial content', 'utf8');
              throw new Error('Partial exception');
            })()
          },
        };
      };

      const packer = createTarPacker(generator());
      const tarPath = join(testDir, 'partial-exception-test.tar');

      // Should reject, but may have written partial content
      await expect(storeReaderToFile(packer, tarPath)).rejects.toThrow('Partial exception');

      // The tar file may exist but be incomplete/corrupted
      // This is expected behavior - when an exception occurs during streaming,
      // the file is left in an inconsistent state
    });
  });
});
