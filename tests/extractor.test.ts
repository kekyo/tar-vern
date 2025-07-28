import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { spawn } from 'child_process';
import { createTarExtractor } from '../src/extractor';
import { CompressionTypes, EntryItem, FileItemReader } from '../src/types';

describe('Tar extractor test', () => {
  const testBaseDir = mkdtempSync(join(tmpdir(), 'tar-vern-extractor-'));
  let testDir: string;

  beforeAll(fn => {
    testDir = join(testBaseDir, fn.name);
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

  const createTar = async (sourceDir: string, tarPath: string, files: string[]) => {
    await runCommand('tar', ['--format=ustar', '-cf', tarPath, '-C', sourceDir, ...files]);
  }

  const createTarGzip = async (sourceDir: string, tarPath: string, files: string[]) => {
    await runCommand('tar', ['--format=ustar', '-czf', tarPath, '-C', sourceDir, ...files]);
  }

  const collectEntries = async (tarPath: string, compressionType?: CompressionTypes): Promise<EntryItem[]> => {
    const entries: EntryItem[] = [];
    const stream = createReadStream(tarPath);
    
    for await (const entry of createTarExtractor(stream, compressionType)) {
      entries.push(entry);
    }
    
    return entries;
  };

  it('should extract a simple string file from tar', async () => {
    // Create a test file
    const sourceDir = join(testDir, 'source1');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'test.txt'), 'Hello, world!');
    
    // Create tar with tar command
    const tarPath = join(testDir, 'simple.tar');
    await createTar(sourceDir, tarPath, ['test.txt']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('file');
    expect(entries[0].path).toBe('test.txt');
    
    // Verify content using FileItemReader
    const fileEntry = entries[0] as any;
    expect(fileEntry.content).toBeDefined();
    const reader = fileEntry.content as FileItemReader;
    
    const contentAsString = await reader.getContent('string');
    expect(contentAsString).toBe('Hello, world!');
    
    const contentAsBuffer = await reader.getContent('buffer');
    expect(contentAsBuffer.toString()).toBe('Hello, world!');
  });

  it('should extract directory entries', async () => {
    // Create a directory structure
    const sourceDir = join(testDir, 'source2');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(sourceDir, 'test-dir'), { recursive: true });
    
    // Create tar with tar command
    const tarPath = join(testDir, 'dir.tar');
    await createTar(sourceDir, tarPath, ['test-dir']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('directory');
    expect(entries[0].path).toBe('test-dir');
  });

  it('should extract multiple files with different content types', async () => {
    // Create files
    const sourceDir = join(testDir, 'source3');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'string-file.txt'), 'Test data for multiple files');
    writeFileSync(join(sourceDir, 'buffer-file.bin'), Buffer.from('Buffer content here', 'utf8'));
    mkdirSync(join(sourceDir, 'subdir'), { recursive: true });
    writeFileSync(join(sourceDir, 'subdir', 'nested.txt'), 'Nested content');
    
    // Create tar with tar command
    const tarPath = join(testDir, 'multi.tar');
    await createTar(sourceDir, tarPath, ['string-file.txt', 'buffer-file.bin', 'subdir']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    expect(entries.length).toBeGreaterThanOrEqual(3);
    
    // Find specific entries
    const stringFile = entries.find(e => e.path === 'string-file.txt');
    const bufferFile = entries.find(e => e.path === 'buffer-file.bin');
    const subdir = entries.find(e => e.path === 'subdir' && e.kind === 'directory');
    const nestedFile = entries.find(e => e.path === 'subdir/nested.txt');
    
    expect(stringFile).toBeDefined();
    expect(stringFile!.kind).toBe('file');
    const content1 = await (stringFile as any).content.getContent('string');
    expect(content1).toBe('Test data for multiple files');
    
    expect(bufferFile).toBeDefined();
    expect(bufferFile!.kind).toBe('file');
    const content2 = await (bufferFile as any).content.getContent('string');
    expect(content2).toBe('Buffer content here');
    
    expect(subdir).toBeDefined();
    expect(subdir!.kind).toBe('directory');
    
    expect(nestedFile).toBeDefined();
    expect(nestedFile!.kind).toBe('file');
    const content3 = await (nestedFile as any).content.getContent('string');
    expect(content3).toBe('Nested content');
  });

  it('should extract large files correctly', async () => {
    // Generate 1MB of random data
    const sourceDir = join(testDir, 'source4');
    mkdirSync(sourceDir, { recursive: true });
    
    const size1MB = 1024 * 1024;
    const randomData = Buffer.allocUnsafe(size1MB);
    for (let i = 0; i < size1MB; i++) {
      randomData[i] = Math.floor(Math.random() * 256);
    }
    writeFileSync(join(sourceDir, 'large.bin'), randomData);
    
    // Create tar with tar command
    const tarPath = join(testDir, 'large.tar');
    await createTar(sourceDir, tarPath, ['large.bin']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('file');
    expect(entries[0].path).toBe('large.bin');
    
    const extractedData = await (entries[0] as any).content.getContent('buffer');
    expect(extractedData.length).toBe(size1MB);
    expect(extractedData.equals(randomData)).toBe(true);
  });

  it('should preserve file metadata accurately', async () => {
    // Create file with specific permissions
    const sourceDir = join(testDir, 'source5');
    mkdirSync(sourceDir, { recursive: true });
    const filePath = join(sourceDir, 'metadata-test.txt');
    writeFileSync(filePath, 'Metadata test');
    chmodSync(filePath, 0o755);
    
    // Create tar with tar command preserving metadata
    const tarPath = join(testDir, 'metadata.tar');
    await createTar(sourceDir, tarPath, ['metadata-test.txt']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    
    expect(entry.kind).toBe('file');
    expect(entry.path).toBe('metadata-test.txt');
    expect(entry.mode & 0o777).toBe(0o755);
  });

  it('should handle empty files', async () => {
    // Create empty file
    const sourceDir = join(testDir, 'source6');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'empty.txt'), '');
    
    // Create tar with tar command
    const tarPath = join(testDir, 'empty.tar');
    await createTar(sourceDir, tarPath, ['empty.txt']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('file');
    expect(entries[0].path).toBe('empty.txt');
    
    const content = await (entries[0] as any).content.getContent('string');
    expect(content).toBe('');
  });

  it('should extract files with long paths correctly', async () => {
    // Create a deep directory structure
    const sourceDir = join(testDir, 'source7');
    const deepPath = 'very/long/path/that/exceeds/one/hundred/characters/limit/in/traditional/tar/format/test/file/with/very/long';
    const fullPath = join(sourceDir, deepPath);
    mkdirSync(fullPath, { recursive: true });
    writeFileSync(join(fullPath, 'name.txt'), 'Long path content');
    
    // Create tar with tar command
    const tarPath = join(testDir, 'longpath.tar');
    await createTar(sourceDir, tarPath, ['very']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    const fileEntry = entries.find(e => e.path.includes('name.txt'));
    expect(fileEntry).toBeDefined();
    expect(fileEntry!.kind).toBe('file');
    
    const content = await (fileEntry as any).content.getContent('string');
    expect(content).toBe('Long path content');
  });

  it('should handle UTF-8 filenames correctly', async () => {
    // Create files with UTF-8 names
    const sourceDir = join(testDir, 'source8');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(sourceDir, 'テスト'), { recursive: true });
    writeFileSync(join(sourceDir, 'テスト', 'ファイル.txt'), '日本語のコンテンツ');
    
    // Create tar with tar command
    const tarPath = join(testDir, 'utf8.tar');
    await createTar(sourceDir, tarPath, ['テスト']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    const fileEntry = entries.find(e => e.path === 'テスト/ファイル.txt');
    expect(fileEntry).toBeDefined();
    expect(fileEntry!.kind).toBe('file');
    
    const content = await (fileEntry as any).content.getContent('string');
    expect(content).toBe('日本語のコンテンツ');
  });

  it('should extract gzip compressed tar files', async () => {
    // Create test file
    const sourceDir = join(testDir, 'source9');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'compressed.txt'), 'This is compressed content');
    
    // Create tar.gz with tar command
    const tgzPath = join(testDir, 'compressed.tar.gz');
    await createTarGzip(sourceDir, tgzPath, ['compressed.txt']);

    // Extract with gzip decompression
    const entries = await collectEntries(tgzPath, 'gzip');
    
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('file');
    expect(entries[0].path).toBe('compressed.txt');
    
    const content = await (entries[0] as any).content.getContent('string');
    expect(content).toBe('This is compressed content');
  });

  it('should handle FileItemReader getContent with both string and buffer types', async () => {
    // Create test file
    const sourceDir = join(testDir, 'source10');
    mkdirSync(sourceDir, { recursive: true });
    const testContent = 'Test content for FileItemReader';
    writeFileSync(join(sourceDir, 'reader-test.txt'), testContent);
    
    // Create tar with tar command
    const tarPath = join(testDir, 'reader.tar');
    await createTar(sourceDir, tarPath, ['reader-test.txt']);

    // Extract
    const entries = await collectEntries(tarPath);
    
    expect(entries).toHaveLength(1);
    const reader = (entries[0] as any).content as FileItemReader;
    
    // Test getContent('string')
    const stringContent = await reader.getContent('string');
    expect(typeof stringContent).toBe('string');
    expect(stringContent).toBe(testContent);
    
    // Test getContent('buffer')
    const bufferContent = await reader.getContent('buffer');
    expect(Buffer.isBuffer(bufferContent)).toBe(true);
    expect(bufferContent.toString()).toBe(testContent);
    
    // Both should return the same content
    expect(bufferContent.toString()).toBe(stringContent);
  });

  it('should properly handle padding in tar format', async () => {
    // Create files with sizes that test padding
    const sourceDir = join(testDir, 'source11');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'odd-size.txt'), 'x'.repeat(513)); // 513 bytes - needs padding
    writeFileSync(join(sourceDir, 'exact-size.txt'), 'y'.repeat(512)); // 512 bytes - no padding needed
    
    // Create tar with tar command
    const tarPath = join(testDir, 'padding.tar');
    await createTar(sourceDir, tarPath, ['odd-size.txt', 'exact-size.txt']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    expect(entries).toHaveLength(2);
    
    // Verify files
    const oddFile = entries.find(e => e.path === 'odd-size.txt');
    const exactFile = entries.find(e => e.path === 'exact-size.txt');
    
    expect(oddFile).toBeDefined();
    const content1 = await (oddFile as any).content.getContent('string');
    expect(content1).toBe('x'.repeat(513));
    
    expect(exactFile).toBeDefined();
    const content2 = await (exactFile as any).content.getContent('string');
    expect(content2).toBe('y'.repeat(512));
  });

  it('should handle mixed file and directory entries', async () => {
    // Create complex directory structure
    const sourceDir = join(testDir, 'source12');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'file1.txt'), 'File 1');
    mkdirSync(join(sourceDir, 'dir1'), { recursive: true });
    writeFileSync(join(sourceDir, 'dir1', 'file2.txt'), 'File 2');
    mkdirSync(join(sourceDir, 'dir1', 'dir2'), { recursive: true });
    writeFileSync(join(sourceDir, 'dir1', 'dir2', 'file3.txt'), 'File 3');
    
    // Create tar with tar command
    const tarPath = join(testDir, 'mixed.tar');
    await createTar(sourceDir, tarPath, ['file1.txt', 'dir1']);

    // Extract and verify structure
    const entries = await collectEntries(tarPath);
    
    
    // Check that we have the expected structure
    const file1 = entries.find(e => e.path === 'file1.txt');
    const dir1 = entries.find(e => e.path === 'dir1' && e.kind === 'directory');
    const file2 = entries.find(e => e.path === 'dir1/file2.txt');
    const dir2 = entries.find(e => e.path === 'dir1/dir2' && e.kind === 'directory');
    const file3 = entries.find(e => e.path === 'dir1/dir2/file3.txt');
    
    expect(file1).toBeDefined();
    expect(file1!.kind).toBe('file');
    
    expect(dir1).toBeDefined();
    expect(dir1!.kind).toBe('directory');
    
    expect(file2).toBeDefined();
    expect(file2!.kind).toBe('file');
    
    expect(dir2).toBeDefined();
    expect(dir2!.kind).toBe('directory');
    
    expect(file3).toBeDefined();
    expect(file3!.kind).toBe('file');
    
    // Verify content
    const content1 = await (file1 as any).content.getContent('string');
    expect(content1).toBe('File 1');
    
    const content2 = await (file2 as any).content.getContent('string');
    expect(content2).toBe('File 2');
    
    const content3 = await (file3 as any).content.getContent('string');
    expect(content3).toBe('File 3');
  });

  it('should handle binary files correctly', async () => {
    // Create binary file with all possible byte values
    const sourceDir = join(testDir, 'source13');
    mkdirSync(sourceDir, { recursive: true });
    
    const binaryData = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) {
      binaryData[i] = i;
    }
    writeFileSync(join(sourceDir, 'binary.dat'), binaryData);
    
    // Create tar with tar command
    const tarPath = join(testDir, 'binary.tar');
    await createTar(sourceDir, tarPath, ['binary.dat']);

    // Extract and verify
    const entries = await collectEntries(tarPath);
    
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('file');
    expect(entries[0].path).toBe('binary.dat');
    
    const extractedData = await (entries[0] as any).content.getContent('buffer');
    expect(extractedData.length).toBe(256);
    expect(extractedData.equals(binaryData)).toBe(true);
  });

  describe('Error handling', () => {
    it('should throw error for invalid tar format', async () => {
      // Create an invalid tar file
      const invalidTarPath = join(testDir, 'invalid.tar');
      writeFileSync(invalidTarPath, 'This is not a valid tar file');
      
      const stream = createReadStream(invalidTarPath);
      const extractor = createTarExtractor(stream);
      
      await expect(async () => {
        const entries: EntryItem[] = [];
        for await (const entry of extractor) {
          entries.push(entry);
        }
      }).rejects.toThrow('Invalid tar format');
    });

    it('should throw error for corrupted header checksum', async () => {
      // Create a valid tar first
      const sourceDir = join(testDir, 'source-corrupt');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'test.txt'), 'Test content');
      
      const tarPath = join(testDir, 'corrupt.tar');
      await createTar(sourceDir, tarPath, ['test.txt']);
      
      // Corrupt the checksum field
      const tarData = readFileSync(tarPath);
      tarData[150] = 0xFF; // Corrupt checksum
      writeFileSync(tarPath, tarData);
      
      const stream = createReadStream(tarPath);
      const extractor = createTarExtractor(stream);
      
      await expect(async () => {
        const entries: EntryItem[] = [];
        for await (const entry of extractor) {
          entries.push(entry);
        }
      }).rejects.toThrow('Invalid checksum');
    });

    it('should handle unexpected end of stream', async () => {
      // Create a large file
      const sourceDir = join(testDir, 'source-truncate');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'large.txt'), 'x'.repeat(10000));
      
      const tarPath = join(testDir, 'full.tar');
      await createTar(sourceDir, tarPath, ['large.txt']);
      
      // Truncate the file
      const tarData = readFileSync(tarPath);
      const truncatedPath = join(testDir, 'truncated.tar');
      writeFileSync(truncatedPath, tarData.subarray(0, 800)); // Cut in the middle
      
      const stream = createReadStream(truncatedPath);
      const extractor = createTarExtractor(stream);
      
      const promise = (async () => {
        const entries: EntryItem[] = [];
        for await (const entry of extractor) {
          entries.push(entry);
        }
      })();
      
      await expect(promise).rejects.toThrow();
    });

    it('should handle abort signal', async () => {
      // Create a tar with many files
      const sourceDir = join(testDir, 'source-abort');
      mkdirSync(sourceDir, { recursive: true });
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(sourceDir, `file${i}.txt`), 'x'.repeat(1000));
      }
      
      const tarPath = join(testDir, 'large-abort.tar');
      await createTar(sourceDir, tarPath, ['.']);
      
      // Extract with abort signal
      const controller = new AbortController();
      const stream = createReadStream(tarPath);
      const extractor = createTarExtractor(stream, undefined, controller.signal);
      
      let count = 0;
      const promise = (async () => {
        for await (const _ of extractor) {
          count++;
          if (count === 5) {
            controller.abort();
          }
        }
      })();
      
      await expect(promise).rejects.toThrow('aborted');
      expect(count).toBe(5);
    });
  });
});