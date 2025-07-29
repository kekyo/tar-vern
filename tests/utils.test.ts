// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createReadStream } from 'fs';
import dayjs from 'dayjs';
import { createTarPacker, createTarExtractor, createEntryItemGenerator, extractTo, EntryItem } from '../src';

describe('Helper functions test', () => {
  const tempBaseDir = join(tmpdir(), 'tar-vern-test', 'utils', dayjs().format('YYYYMMDD_HHmmssSSS'));

  let testDir: string;

  beforeEach(fn => {
    testDir = join(tempBaseDir, fn.task.name);
    mkdirSync(testDir, { recursive: true });
  });

  describe('createEntryItemGenerator', () => {
    it('should create entry items from filesystem paths', async () => {
      // Create test files and directories
      const sourceDir = join(testDir, 'source');
      mkdirSync(sourceDir, { recursive: true });
      
      writeFileSync(join(sourceDir, 'file1.txt'), 'Content 1');
      writeFileSync(join(sourceDir, 'file2.txt'), 'Content 2');
      
      const subDir = join(sourceDir, 'subdir');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'file3.txt'), 'Content 3');

      // Test createEntryItemGenerator
      const relativePaths = [
        'file1.txt',
        'file2.txt', 
        'subdir',
        'subdir/file3.txt'
      ];

      const entries: EntryItem[] = [];
      for await (const entry of createEntryItemGenerator(sourceDir, relativePaths)) {
        entries.push(entry);
      }

      // Verify entries
      expect(entries).toHaveLength(4);
      
      const file1 = entries.find(e => e.path.endsWith('file1.txt'));
      const file2 = entries.find(e => e.path.endsWith('file2.txt'));
      const dir = entries.find(e => e.path.endsWith('subdir'));
      const file3 = entries.find(e => e.path.endsWith('file3.txt'));

      expect(file1?.kind).toBe('file');
      expect(file2?.kind).toBe('file');
      expect(dir?.kind).toBe('directory');
      expect(file3?.kind).toBe('file');
    });

    it('should handle non-existent paths gracefully', async () => {
      const relativePaths = [
        'nonexistent.txt',
        'also-nonexistent'
      ];

      const entries: EntryItem[] = [];
      for await (const entry of createEntryItemGenerator(testDir, relativePaths)) {
        entries.push(entry);
      }

      // Should yield no entries but not throw errors
      expect(entries).toHaveLength(0);
    });

    it('should respect reflectStat parameter', async () => {
      // Create test file
      const sourceDir = join(testDir, 'reflect-test');
      mkdirSync(sourceDir, { recursive: true });
      const testFile = join(sourceDir, 'test.txt');
      writeFileSync(testFile, 'Test content');

      // Test with 'all' reflectStat
      const entries: EntryItem[] = [];
      for await (const entry of createEntryItemGenerator(sourceDir, ['test.txt'], 'all')) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
      const fileEntry = entries[0];
      expect(fileEntry.kind).toBe('file');
      
      // Should have reflected stats
      const stats = statSync(testFile);
      expect(fileEntry.mode).toBe(stats.mode);
      expect(fileEntry.uid).toBe(stats.uid);
      expect(fileEntry.gid).toBe(stats.gid);
    });

    it('should collect all files when relativePaths is omitted', async () => {
      // Create test directory structure
      const sourceDir = join(testDir, 'auto-collect');
      mkdirSync(sourceDir, { recursive: true });
      
      writeFileSync(join(sourceDir, 'file1.txt'), 'Content 1');
      writeFileSync(join(sourceDir, 'file2.txt'), 'Content 2');
      
      const subDir = join(sourceDir, 'subdir');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'file3.txt'), 'Content 3');
      
      const nestedDir = join(subDir, 'nested');
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, 'file4.txt'), 'Content 4');

      // Test createEntryItemGenerator without relativePaths
      const entries: EntryItem[] = [];
      for await (const entry of createEntryItemGenerator(sourceDir)) {
        entries.push(entry);
      }

      // Should collect all files and directories recursively
      expect(entries.length).toBeGreaterThan(0);
      
      // Verify we got all expected entries
      const paths = entries.map(e => e.path).sort();
      expect(paths).toContain('file1.txt');
      expect(paths).toContain('file2.txt');
      expect(paths).toContain('subdir');
      expect(paths).toContain(join('subdir', 'file3.txt'));
      expect(paths).toContain(join('subdir', 'nested'));
      expect(paths).toContain(join('subdir', 'nested', 'file4.txt'));

      // Verify entry types
      const file1 = entries.find(e => e.path === 'file1.txt');
      const dir = entries.find(e => e.path === 'subdir');
      const nestedFile = entries.find(e => e.path === join('subdir', 'nested', 'file4.txt'));

      expect(file1?.kind).toBe('file');
      expect(dir?.kind).toBe('directory');
      expect(nestedFile?.kind).toBe('file');
    });

    it('should support abort signal', async () => {
      const sourceDir = join(testDir, 'abort-test');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'file1.txt'), 'Content 1');
      writeFileSync(join(sourceDir, 'file2.txt'), 'Content 2');

      const controller = new AbortController();
      const relativePaths = [
        'file1.txt',
        'file2.txt'
      ];

      const generator = createEntryItemGenerator(sourceDir, relativePaths, 'exceptName', controller.signal);
      
      // Get first entry
      const { value: entry1 } = await generator.next();
      expect(entry1?.kind).toBe('file');

      // Abort the operation
      controller.abort();

      // Should throw on next iteration
      await expect(generator.next()).rejects.toThrow();
    });
  });

  describe('extractTo', () => {
    it('should extract tar entries to filesystem', async () => {
      // Create source files
      const sourceDir = join(testDir, 'source');
      mkdirSync(sourceDir, { recursive: true });
      
      writeFileSync(join(sourceDir, 'file1.txt'), 'Content 1');
      writeFileSync(join(sourceDir, 'file2.txt'), 'Content 2');
      
      const subDir = join(sourceDir, 'subdir');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'file3.txt'), 'Content 3');

      // Create tar from source
      const relativePaths = [
        'file1.txt',
        'file2.txt',
        'subdir',
        'subdir/file3.txt'
      ];

      const itemGenerator = createEntryItemGenerator(sourceDir, relativePaths);
      const packer = createTarPacker(itemGenerator);
      
      // Read tar data into buffer
      const chunks: Buffer[] = [];
      for await (const chunk of packer) {
        chunks.push(Buffer.from(chunk));
      }
      const tarData = Buffer.concat(chunks);

      // Extract to target directory
      const targetDir = join(testDir, 'target');
      mkdirSync(targetDir, { recursive: true });

      const extractor = createTarExtractor(createReadStream(join(testDir, 'test.tar')));
      
      // Write tar data to file first
      const tarPath = join(testDir, 'test.tar');
      writeFileSync(tarPath, tarData);
      
      // Extract
      const extractorStream = createTarExtractor(createReadStream(tarPath));
      await extractTo(extractorStream, targetDir);

      // Verify extracted files
      const extractedFile1 = join(targetDir, 'file1.txt');
      const extractedFile2 = join(targetDir, 'file2.txt');
      const extractedSubDir = join(targetDir, 'subdir');
      const extractedFile3 = join(targetDir, 'subdir', 'file3.txt');

      expect(existsSync(extractedFile1)).toBe(true);
      expect(existsSync(extractedFile2)).toBe(true);
      expect(existsSync(extractedSubDir)).toBe(true);
      expect(existsSync(extractedFile3)).toBe(true);

      expect(readFileSync(extractedFile1, 'utf8')).toBe('Content 1');
      expect(readFileSync(extractedFile2, 'utf8')).toBe('Content 2');
      expect(readFileSync(extractedFile3, 'utf8')).toBe('Content 3');

      // Verify directory
      expect(statSync(extractedSubDir).isDirectory()).toBe(true);
    });

    it('should create parent directories as needed', async () => {
      // Create a nested file structure in tar
      const sourceDir = join(testDir, 'nested-source');
      mkdirSync(sourceDir, { recursive: true });
      
      const deepDir = join(sourceDir, 'level1', 'level2', 'level3');
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, 'deep-file.txt'), 'Deep content');

      const relativePaths = [
        'level1',
        'level1/level2',
        'level1/level2/level3',
        'level1/level2/level3/deep-file.txt'
      ];

      const itemGenerator = createEntryItemGenerator(sourceDir, relativePaths);
      const packer = createTarPacker(itemGenerator);
      
      // Create tar file
      const tarPath = join(testDir, 'nested.tar');
      const chunks: Buffer[] = [];
      for await (const chunk of packer) {
        chunks.push(Buffer.from(chunk));
      }
      writeFileSync(tarPath, Buffer.concat(chunks));

      // Extract to target
      const targetDir = join(testDir, 'nested-target');
      const extractorStream = createTarExtractor(createReadStream(tarPath));
      await extractTo(extractorStream, targetDir);

      // Verify nested structure
      const extractedFile = join(targetDir, 'level1', 'level2', 'level3', 'deep-file.txt');
      expect(existsSync(extractedFile)).toBe(true);
      expect(readFileSync(extractedFile, 'utf8')).toBe('Deep content');
    });

    it('should support abort signal', async () => {
      // Create simple test data
      const sourceDir = join(testDir, 'abort-extract');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'file1.txt'), 'Content 1');
      writeFileSync(join(sourceDir, 'file2.txt'), 'Content 2');

      const relativePaths = [
        'file1.txt',
        'file2.txt'
      ];

      const itemGenerator = createEntryItemGenerator(sourceDir, relativePaths);
      const packer = createTarPacker(itemGenerator);
      
      const tarPath = join(testDir, 'abort.tar');
      const chunks: Buffer[] = [];
      for await (const chunk of packer) {
        chunks.push(Buffer.from(chunk));
      }
      writeFileSync(tarPath, Buffer.concat(chunks));

      // Test with abort signal
      const controller = new AbortController();
      const targetDir = join(testDir, 'abort-target');
      const extractorStream = createTarExtractor(createReadStream(tarPath));

      // Abort immediately
      controller.abort();

      // Should throw when aborted
      await expect(extractTo(extractorStream, targetDir, controller.signal))
        .rejects.toThrow();
    });
  });

  describe('Integration test', () => {
    it('should work together for complete pack/extract workflow', async () => {
      // Create source structure
      const sourceDir = join(testDir, 'integration-source');
      mkdirSync(sourceDir, { recursive: true });
      
      writeFileSync(join(sourceDir, 'readme.txt'), 'This is a readme');
      writeFileSync(join(sourceDir, 'config.json'), '{"name": "test"}');
      
      const docsDir = join(sourceDir, 'docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, 'guide.md'), '# Guide\nThis is a guide');

      // Pack using createEntryItemGenerator
      const relativePaths = [
        'readme.txt',
        'config.json',
        'docs',
        'docs/guide.md'
      ];

      const itemGenerator = createEntryItemGenerator(sourceDir, relativePaths, 'exceptName');
      const packer = createTarPacker(itemGenerator);
      
      const tarPath = join(testDir, 'integration.tar');
      const chunks: Buffer[] = [];
      for await (const chunk of packer) {
        chunks.push(Buffer.from(chunk));
      }
      writeFileSync(tarPath, Buffer.concat(chunks));

      // Extract using extractTo
      const targetDir = join(testDir, 'integration-target');
      const extractorStream = createTarExtractor(createReadStream(tarPath));
      await extractTo(extractorStream, targetDir);

      // Verify complete structure
      expect(existsSync(join(targetDir, 'readme.txt'))).toBe(true);
      expect(existsSync(join(targetDir, 'config.json'))).toBe(true);
      expect(existsSync(join(targetDir, 'docs'))).toBe(true);
      expect(existsSync(join(targetDir, 'docs', 'guide.md'))).toBe(true);

      expect(readFileSync(join(targetDir, 'readme.txt'), 'utf8')).toBe('This is a readme');
      expect(readFileSync(join(targetDir, 'config.json'), 'utf8')).toBe('{"name": "test"}');
      expect(readFileSync(join(targetDir, 'docs', 'guide.md'), 'utf8')).toBe('# Guide\nThis is a guide');

      expect(statSync(join(targetDir, 'docs')).isDirectory()).toBe(true);
    });
  });
});
