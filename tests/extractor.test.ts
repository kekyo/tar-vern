import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadStream, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { spawn } from 'child_process';
import dayjs from 'dayjs';
import { createTarExtractor } from '../src/extractor';
import { CompressionTypes, ExtractedEntryItem, ExtractedFileItem } from '../src/types';

describe('Tar extractor test', () => {
  const tempBaseDir = join(tmpdir(), 'tar-vern-test', 'extractor', dayjs().format('YYYYMMDD_HHmmssSSS'));

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

  const createTar = async (sourceDir: string, tarPath: string, files: string[]) => {
    await runCommand('tar', ['--format=ustar', '-cf', tarPath, '-C', sourceDir, ...files]);
  }

  const createTarGzip = async (sourceDir: string, tarPath: string, files: string[]) => {
    await runCommand('tar', ['--format=ustar', '-czf', tarPath, '-C', sourceDir, ...files]);
  }

  const collectEntries = async (tarPath: string, compressionType?: CompressionTypes): Promise<(ExtractedEntryItem & { content?: string | Buffer })[]> => {
    const entries: (ExtractedEntryItem & { content?: string | Buffer })[] = [];
    const stream = createReadStream(tarPath);
    
    for await (const entry of createTarExtractor(stream, compressionType)) {
      if (entry.kind === 'file') {
        // Immediately consume file content to avoid streaming issues
        const content = await (entry as ExtractedFileItem).getContent('buffer');
        entries.push({ ...entry, content });
      } else {
        entries.push(entry);
      }
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
    
    // Verify content
    const fileItem = entries[0];
    expect(fileItem.content).toBeDefined();
    expect(fileItem.content!.toString('utf8')).toBe('Hello, world!');
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
    expect(stringFile!.content).toBeDefined();
    expect(stringFile!.content!.toString('utf8')).toBe('Test data for multiple files');
    
    expect(bufferFile).toBeDefined();
    expect(bufferFile!.kind).toBe('file');
    expect(bufferFile!.content).toBeDefined();
    expect(bufferFile!.content!.toString('utf8')).toBe('Buffer content here');
    
    expect(subdir).toBeDefined();
    expect(subdir!.kind).toBe('directory');
    
    expect(nestedFile).toBeDefined();
    expect(nestedFile!.kind).toBe('file');
    expect(nestedFile!.content).toBeDefined();
    expect(nestedFile!.content!.toString('utf8')).toBe('Nested content');
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
    
    expect(entries[0].content).toBeDefined();
    expect(entries[0].content!.length).toBe(size1MB);
    expect((entries[0].content! as Buffer).equals(randomData)).toBe(true);
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
    
    expect(entries[0].content).toBeDefined();
    expect(entries[0].content!.toString('utf8')).toBe('');
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
    
    expect(fileEntry!.content).toBeDefined();
    expect(fileEntry!.content!.toString('utf8')).toBe('Long path content');
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
    
    expect(fileEntry!.content).toBeDefined();
    expect(fileEntry!.content!.toString('utf8')).toBe('日本語のコンテンツ');
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
    
    expect(entries[0].content).toBeDefined();
    expect(entries[0].content!.toString('utf8')).toBe('This is compressed content');
  });

  it('should handle getContent with string, buffer, and readable types', async () => {
    // Create test file
    const sourceDir = join(testDir, 'source10');
    mkdirSync(sourceDir, { recursive: true });
    const testContent = 'Test content for FileItemReader';
    writeFileSync(join(sourceDir, 'reader-test.txt'), testContent);
    
    // Create tar with tar command
    const tarPath = join(testDir, 'reader.tar');
    await createTar(sourceDir, tarPath, ['reader-test.txt']);

    // Test string content
    {
      const stream1 = createReadStream(tarPath);
      const extractor1 = createTarExtractor(stream1);
      const { value: entry1 } = await extractor1.next();
      expect(entry1!.kind).toBe('file');
      const stringContent = await (entry1 as ExtractedFileItem).getContent('string');
      expect(typeof stringContent).toBe('string');
      expect(stringContent).toBe(testContent);
    }
    
    // Test buffer content  
    {
      const stream2 = createReadStream(tarPath);
      const extractor2 = createTarExtractor(stream2);
      const { value: entry2 } = await extractor2.next();
      expect(entry2!.kind).toBe('file');
      const bufferContent = await (entry2 as ExtractedFileItem).getContent('buffer');
      expect(Buffer.isBuffer(bufferContent)).toBe(true);
      expect(bufferContent.toString('utf8')).toBe(testContent);
    }
    
    // Test readable content
    {
      const stream3 = createReadStream(tarPath);
      const extractor3 = createTarExtractor(stream3);
      const { value: entry3 } = await extractor3.next();
      expect(entry3!.kind).toBe('file');
      const readableContent = await (entry3 as ExtractedFileItem).getContent('readable');
      expect(readableContent).toBeInstanceOf(require('stream').Readable);
      
      // Read from readable stream
      const chunks: Buffer[] = [];
      for await (const chunk of readableContent) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const readableData = Buffer.concat(chunks).toString('utf8');
      expect(readableData).toBe(testContent);
    }
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
    expect(oddFile!.content).toBeDefined();
    expect(oddFile!.content!.toString('utf8')).toBe('x'.repeat(513));
    
    expect(exactFile).toBeDefined();
    expect(exactFile!.content).toBeDefined();
    expect(exactFile!.content!.toString('utf8')).toBe('y'.repeat(512));
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
    expect(file1!.content).toBeDefined();
    expect(file1!.content!.toString('utf8')).toBe('File 1');
    
    expect(file2!.content).toBeDefined();
    expect(file2!.content!.toString('utf8')).toBe('File 2');
    
    expect(file3!.content).toBeDefined();
    expect(file3!.content!.toString('utf8')).toBe('File 3');
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
    
    expect(entries[0].content).toBeDefined();
    expect(entries[0].content!.length).toBe(256);
    expect((entries[0].content! as Buffer).equals(binaryData)).toBe(true);
  });

  describe('Error handling', () => {
    it('should throw error for invalid tar format', async () => {
      // Create an invalid tar file
      const invalidTarPath = join(testDir, 'invalid.tar');
      writeFileSync(invalidTarPath, 'This is not a valid tar file');
      
      const stream = createReadStream(invalidTarPath);
      const extractor = createTarExtractor(stream);
      
      await expect(async () => {
        const entries: ExtractedEntryItem[] = [];
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
        const entries: ExtractedEntryItem[] = [];
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
        const entries: ExtractedEntryItem[] = [];
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

    it('should throw error on multiple calls to getContent', async () => {
      // Create test file
      const sourceDir = join(testDir, 'multiple-calls');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'test.txt'), 'Test content');
      
      const tarPath = join(testDir, 'multiple-calls.tar');
      await createTar(sourceDir, tarPath, ['test.txt']);

      // Test multiple calls to getContent
      const stream = createReadStream(tarPath);
      const extractor = createTarExtractor(stream);
      const { value: entry } = await extractor.next();
      
      expect(entry!.kind).toBe('file');
      const fileItem = entry as ExtractedFileItem;
      
      // First call should succeed
      const content1 = await fileItem.getContent('string');
      expect(content1).toBe('Test content');
      
      // Second call should throw error
      await expect(fileItem.getContent('string')).rejects.toThrow('Content has already been consumed. Multiple calls to getContent are not supported.');
      
      // Third call with different type should also throw error
      await expect(fileItem.getContent('buffer')).rejects.toThrow('Content has already been consumed. Multiple calls to getContent are not supported.');
    });

    it('should throw error when calling getContent after enumeration has progressed', async () => {
      // Create test files
      const sourceDir = join(testDir, 'enum-progress');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'file1.txt'), 'Content 1');
      writeFileSync(join(sourceDir, 'file2.txt'), 'Content 2');
      
      const tarPath = join(testDir, 'enum-progress.tar');
      await createTar(sourceDir, tarPath, ['file1.txt', 'file2.txt']);

      // Start extraction
      const stream = createReadStream(tarPath);
      const extractor = createTarExtractor(stream);
      
      // Get first entry but don't consume content
      const { value: entry1 } = await extractor.next();
      expect(entry1!.kind).toBe('file');
      const fileItem1 = entry1 as ExtractedFileItem;
      
      // Get second entry (this should auto-skip first file content)
      const { value: entry2 } = await extractor.next();
      expect(entry2!.kind).toBe('file');
      
      // Now trying to call getContent on first entry should throw error
      await expect(fileItem1.getContent('string')).rejects.toThrow('Content has already been consumed. Multiple calls to getContent are not supported.');
      await expect(fileItem1.getContent('buffer')).rejects.toThrow('Content has already been consumed. Multiple calls to getContent are not supported.');
      await expect(fileItem1.getContent('readable')).rejects.toThrow('Content has already been consumed. Multiple calls to getContent are not supported.');
      
      // But second entry should still work
      const content2 = await (entry2 as ExtractedFileItem).getContent('string');
      expect(content2).toBe('Content 2');
    });

    it('should throw error on multiple calls to getContent even with readable type', async () => {
      // Create test file
      const sourceDir = join(testDir, 'readable-multiple');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'test.txt'), 'Test content for readable');
      
      const tarPath = join(testDir, 'readable-multiple.tar');
      await createTar(sourceDir, tarPath, ['test.txt']);

      // Test readable type multiple calls
      const stream = createReadStream(tarPath);
      const extractor = createTarExtractor(stream);
      const { value: entry } = await extractor.next();
      
      expect(entry!.kind).toBe('file');
      const fileItem = entry as ExtractedFileItem;
      
      // First call with readable should succeed
      const readable1 = await fileItem.getContent('readable');
      expect(readable1).toBeDefined();
      
      // Consume the readable stream
      const chunks: Buffer[] = [];
      for await (const chunk of readable1) {
        chunks.push(Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks).toString('utf8');
      expect(content).toBe('Test content for readable');
      
      // Second call should throw error (even though first was readable)
      await expect(fileItem.getContent('string')).rejects.toThrow('Content has already been consumed. Multiple calls to getContent are not supported.');
      await expect(fileItem.getContent('readable')).rejects.toThrow('Content has already been consumed. Multiple calls to getContent are not supported.');
    });
  });
});
