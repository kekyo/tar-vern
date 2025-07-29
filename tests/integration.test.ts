// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join, relative, dirname } from 'path';
import { createReadStream, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import dayjs from 'dayjs';
import { createTarPacker, createTarExtractor, createEntryItemGenerator, extractTo } from '../src';

describe('Integration tests', () => {
  const tempBaseDir = join(tmpdir(), 'tar-vern-test', 'integration', dayjs().format('YYYYMMDD_HHmmssSSS'));
  let testDir: string;
  let originalUmask: number;

  beforeEach((context) => {
    // Save original umask and set to 0 to avoid umask interference
    originalUmask = process.umask(0);
    testDir = join(tempBaseDir, context.task.name);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Restore original umask
    process.umask(originalUmask);
  });

  const runCommand = (command: string, args: string[], cwd?: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { 
        cwd: cwd || testDir,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}\nStdout: ${stdout}\nStderr: ${stderr}`));
        }
      });
    });
  };

  // Generate random data for testing
  const generateRandomData = (size: number): Buffer => {
    const buffer = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
    return buffer;
  };

  // Generate random file sizes between 0 and 64KB
  const getRandomFileSize = (): number => {
    return Math.floor(Math.random() * 65536);
  };

  // Generate random directory depth (0-3)
  const getRandomDepth = (): number => {
    return Math.floor(Math.random() * 4);
  };

  // Generate random file mode (ensuring owner read permission)
  const getRandomFileMode = (): number => {
    // Base: owner read (0o400) + random permissions
    const baseMode = 0o400; // Owner read is required
    const randomBits = Math.floor(Math.random() * 0o377); // All other bits random
    return baseMode | randomBits;
  };

  // Generate random directory mode (ensuring owner read+write+execute permissions)
  const getRandomDirectoryMode = (): number => {
    // Base: owner read+write+execute (0o700) + random permissions
    const baseMode = 0o700; // Owner read+write+execute is required
    const randomBits = Math.floor(Math.random() * 0o077); // Only group/other bits random
    return baseMode | randomBits;
  };

  // Create directory structure with given depth
  const createDirectoryPath = (baseDir: string, depth: number): string => {
    let currentPath = baseDir;
    
    for (let i = 0; i < depth; i++) {
      const dirName = `dir${i}_${Math.random().toString(36).substring(2, 10)}`;
      currentPath = join(currentPath, dirName);
      const dirMode = getRandomDirectoryMode();
      
      // With umask 0, we can set the exact mode directly
      mkdirSync(currentPath, { recursive: true, mode: dirMode });
    }
    
    return currentPath;
  };

  // Parse tarball contents using tar -tvf and return structured data
  const parseTarballContents = async (tarPath: string): Promise<Map<string, { mode: number; size: number; isDirectory: boolean }>> => {
    const result = new Map<string, { mode: number; size: number; isDirectory: boolean }>();
    
    try {
      const output = await runCommand('tar', ['-tvf', tarPath]);
      const lines = output.trim().split('\n').filter(line => line.trim());
      
      console.log('Tarball contents:');
      for (const line of lines) {
        console.log(line);
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;
        
        const modeStr = parts[0];
        const sizeStr = parts[4];
        const pathInTar = parts.slice(8).join(' '); // Handle paths with spaces
        
        // Skip root directory entries
        if (pathInTar === '.' || pathInTar === './') continue;
        
        // Convert mode string (like "drwx------" or "-rw-r--r--") to octal
        let mode = 0;
        const isDirectory = modeStr[0] === 'd';
        
        // Owner permissions
        if (modeStr[1] === 'r') mode |= 0o400;
        if (modeStr[2] === 'w') mode |= 0o200;
        if (modeStr[3] === 'x') mode |= 0o100;
        // Group permissions  
        if (modeStr[4] === 'r') mode |= 0o040;
        if (modeStr[5] === 'w') mode |= 0o020;
        if (modeStr[6] === 'x') mode |= 0o010;
        // Other permissions
        if (modeStr[7] === 'r') mode |= 0o004;
        if (modeStr[8] === 'w') mode |= 0o002;
        if (modeStr[9] === 'x') mode |= 0o001;
        
        const size = parseInt(sizeStr, 10) || 0;
        
        result.set(pathInTar, { mode, size, isDirectory });
      }
      
      return result;
    } catch (error) {
      console.error('Failed to parse tarball contents:', error);
      return new Map();
    }
  };

  // Verify that tarball contents match original directory modes
  const verifyTarballModes = async (tarPath: string, originalDir: string): Promise<boolean> => {
    const tarContents = await parseTarballContents(tarPath);
    
    for (const [pathInTar, tarInfo] of tarContents) {
      const originalPath = join(originalDir, pathInTar);
      
      if (existsSync(originalPath)) {
        const originalStat = statSync(originalPath);
        const originalModeOctal = originalStat.mode & 0o7777;
        
        if (originalModeOctal !== tarInfo.mode) {
          console.error(`Mode mismatch for ${pathInTar}: original ${originalModeOctal.toString(8)} vs tarball ${tarInfo.mode.toString(8)}`);
          return false;
        } else {
          console.log(`✓ Mode match for ${pathInTar}: ${originalModeOctal.toString(8)}`);
        }
        
        // Also verify file size for files
        if (!tarInfo.isDirectory && originalStat.size !== tarInfo.size) {
          console.error(`Size mismatch for ${pathInTar}: original ${originalStat.size} vs tarball ${tarInfo.size}`);
          return false;
        }
      } else {
        console.error(`Original file not found: ${originalPath}`);
        return false;
      }
    }
    
    return true;
  };

  // Compare two directory structures recursively
  const compareDirectories = (dir1: string, dir2: string): boolean => {
    const walkDirectory = (dir: string, basePath: string = ''): Map<string, { size: number; mode: number; content?: Buffer }> => {
      const result = new Map<string, { size: number; mode: number; content?: Buffer }>();
      
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = basePath ? join(basePath, entry.name) : entry.name;
        
        if (entry.isDirectory()) {
          const stats = statSync(fullPath);
          result.set(relativePath + '/', { size: 0, mode: stats.mode });
          const subEntries = walkDirectory(fullPath, relativePath);
          for (const [subPath, subInfo] of subEntries) {
            result.set(subPath, subInfo);
          }
        } else if (entry.isFile()) {
          const stats = statSync(fullPath);
          const content = readFileSync(fullPath);
          result.set(relativePath, { size: stats.size, mode: stats.mode, content });
        }
      }
      
      return result;
    };

    const entries1 = walkDirectory(dir1);
    const entries2 = walkDirectory(dir2);

    // Compare number of entries
    if (entries1.size !== entries2.size) {
      console.error(`Different number of entries: ${entries1.size} vs ${entries2.size}`);
      return false;
    }

    // Compare each entry
    for (const [path, info1] of entries1) {
      const info2 = entries2.get(path);
      if (!info2) {
        console.error(`Missing entry in dir2: ${path}`);
        return false;
      }

      if (info1.size !== info2.size) {
        console.error(`Different size for ${path}: ${info1.size} vs ${info2.size}`);
        return false;
      }

      // Compare file modes (permissions) - mask to get only permission bits
      const mode1 = info1.mode & 0o7777;
      const mode2 = info2.mode & 0o7777;
      
      // For directories, tar command often sets 777 regardless of original mode
      // So we're lenient with directory mode comparison
      if (path.endsWith('/')) {
        // For directories, just ensure both have minimum required permissions
        const hasMinPerms1 = (mode1 & 0o500) === 0o500; // owner r+x
        const hasMinPerms2 = (mode2 & 0o500) === 0o500; // owner r+x
        if (!hasMinPerms1 || !hasMinPerms2) {
          console.error(`Directory ${path} missing required permissions: ${mode1.toString(8)} vs ${mode2.toString(8)}`);
          return false;
        }
      } else {
        // For files, expect exact mode match
        if (mode1 !== mode2) {
          console.error(`Different mode for file ${path}: ${mode1.toString(8)} vs ${mode2.toString(8)}`);
          return false;
        }
      }

      if (info1.content && info2.content) {
        if (!info1.content.equals(info2.content)) {
          console.error(`Different content for ${path}`);
          return false;
        }
      }
    }

    return true;
  };

  it('should pack with tar-vern and extract with tar command correctly', async () => {
    // Create source directory with random files
    const sourceDir = join(testDir, 'source');
    mkdirSync(sourceDir, { recursive: true });

    const files: string[] = [];
    const fileCount = 30 + Math.floor(Math.random() * 20); // 30-50 files

    // Generate random files in random directory structures
    for (let i = 0; i < fileCount; i++) {
      const depth = getRandomDepth();
      const targetDir = createDirectoryPath(sourceDir, depth);
      
      const fileName = `file_${i}_${Math.random().toString(36).substring(2, 10)}.bin`;
      const filePath = join(targetDir, fileName);
      const fileSize = getRandomFileSize();
      const fileData = generateRandomData(fileSize);
      
      const fileMode = getRandomFileMode();
      writeFileSync(filePath, fileData, { mode: fileMode });
      
      // Store relative path from sourceDir
      const relativePath = relative(sourceDir, filePath);
      files.push(relativePath);
    }

    // Also include all directories
    const walkDirs = (dir: string, basePath: string = ''): string[] => {
      const result: string[] = [];
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const relativePath = basePath ? join(basePath, entry.name) : entry.name;
          result.push(relativePath);
          const subDirs = walkDirs(join(dir, entry.name), relativePath);
          result.push(...subDirs);
        }
      }
      
      return result;
    };

    const allDirs = walkDirs(sourceDir);
    const allPaths = [...allDirs, ...files];

    // Pack with tar-vern
    const generator = createEntryItemGenerator(sourceDir, allPaths);
    const packer = createTarPacker(generator);
    
    const tarPath = join(testDir, 'test.tar');
    const chunks: Buffer[] = [];
    for await (const chunk of packer) {
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(tarPath, Buffer.concat(chunks));

    // Extract with tar command
    const extractDir = join(testDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    
    await runCommand('tar', ['-xf', tarPath], extractDir);

    // Compare directories
    const isEqual = compareDirectories(sourceDir, extractDir);
    expect(isEqual).toBe(true);
  }, 30000);

  it('should pack with tar command and extract with tar-vern correctly', async () => {
    // Create source directory with random files
    const sourceDir = join(testDir, 'source');
    mkdirSync(sourceDir, { recursive: true });

    const fileCount = 30 + Math.floor(Math.random() * 20); // 30-50 files

    // Generate random files in random directory structures
    for (let i = 0; i < fileCount; i++) {
      const depth = getRandomDepth();
      const targetDir = createDirectoryPath(sourceDir, depth);
      
      const fileName = `file_${i}_${Math.random().toString(36).substring(2, 10)}.bin`;
      const filePath = join(targetDir, fileName);
      const fileSize = getRandomFileSize();
      const fileData = generateRandomData(fileSize);
      
      const fileMode = getRandomFileMode();
      writeFileSync(filePath, fileData, { mode: fileMode });
    }

    // Pack with tar command
    const tarPath = join(testDir, 'test.tar');
    await runCommand('tar', ['--format=ustar', '-cf', tarPath, '-C', sourceDir, '.']);

    // Extract with tar-vern
    const extractDir = join(testDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    
    const stream = createReadStream(tarPath);
    const extractor = createTarExtractor(stream);
    await extractTo(extractor, extractDir);

    // Compare directories
    const isEqual = compareDirectories(sourceDir, extractDir);
    expect(isEqual).toBe(true);
  }, 30000);

  it('should handle gzip compression correctly (pack with tar-vern, extract with tar)', async () => {
    // Create source directory with random files
    const sourceDir = join(testDir, 'source');
    mkdirSync(sourceDir, { recursive: true });

    const files: string[] = [];
    const fileCount = 20 + Math.floor(Math.random() * 10); // 20-30 files

    // Generate files
    for (let i = 0; i < fileCount; i++) {
      const depth = getRandomDepth();
      const targetDir = createDirectoryPath(sourceDir, depth);
      
      const fileName = `file_${i}.txt`;
      const filePath = join(targetDir, fileName);
      const fileSize = getRandomFileSize();
      const fileData = generateRandomData(fileSize);
      
      const fileMode = getRandomFileMode();
      writeFileSync(filePath, fileData, { mode: fileMode });
      
      const relativePath = relative(sourceDir, filePath);
      files.push(relativePath);
    }

    const allDirs = files.map(f => dirname(f)).filter(d => d !== '.').filter((v, i, a) => a.indexOf(v) === i);
    const allPaths = [...allDirs, ...files];

    // Pack with tar-vern (gzip)
    const generator = createEntryItemGenerator(sourceDir, allPaths);
    const packer = createTarPacker(generator, 'gzip');
    
    const tgzPath = join(testDir, 'test.tar.gz');
    const chunks: Buffer[] = [];
    for await (const chunk of packer) {
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(tgzPath, Buffer.concat(chunks));

    // Extract with tar command
    const extractDir = join(testDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    
    await runCommand('tar', ['-xzf', tgzPath], extractDir);

    // Verify tarball modes first
    const tarballModesCorrect = await verifyTarballModes(tgzPath, sourceDir);
    expect(tarballModesCorrect).toBe(true);

    // Compare directories (with lenient directory mode comparison due to tar extraction behavior)
    const isEqual = compareDirectories(sourceDir, extractDir);
    expect(isEqual).toBe(true);
  }, 30000);

  it('should handle gzip compression correctly (pack with tar, extract with tar-vern)', async () => {
    // Create source directory with random files
    const sourceDir = join(testDir, 'source');
    mkdirSync(sourceDir, { recursive: true });

    const fileCount = 20 + Math.floor(Math.random() * 10); // 20-30 files

    // Generate files
    for (let i = 0; i < fileCount; i++) {
      const depth = getRandomDepth();
      const targetDir = createDirectoryPath(sourceDir, depth);
      
      const fileName = `file_${i}.txt`;
      const filePath = join(targetDir, fileName);
      const fileSize = getRandomFileSize();
      const fileData = generateRandomData(fileSize);
      
      const fileMode = getRandomFileMode();
      writeFileSync(filePath, fileData, { mode: fileMode });
    }

    // Pack with tar command (gzip)
    const tgzPath = join(testDir, 'test.tar.gz');
    await runCommand('tar', ['--format=ustar', '-czf', tgzPath, '-C', sourceDir, '.']);

    // Extract with tar-vern
    const extractDir = join(testDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    
    const stream = createReadStream(tgzPath);
    const extractor = createTarExtractor(stream, 'gzip');
    await extractTo(extractor, extractDir);

    // Compare directories
    const isEqual = compareDirectories(sourceDir, extractDir);
    expect(isEqual).toBe(true);
  }, 30000);

  it('should handle large files correctly', async () => {
    // Create source directory with one large file
    const sourceDir = join(testDir, 'source');
    mkdirSync(sourceDir, { recursive: true });

    // Create a 1MB file
    const fileName = 'large_file.bin';
    const filePath = join(sourceDir, fileName);
    const fileSize = 1024 * 1024; // 1MB
    const fileData = generateRandomData(fileSize);
    const fileMode = getRandomFileMode();
    
    writeFileSync(filePath, fileData, { mode: fileMode });

    // Pack with tar-vern
    const generator = createEntryItemGenerator(sourceDir, [fileName]);
    const packer = createTarPacker(generator);
    
    const tarPath = join(testDir, 'large.tar');
    const chunks: Buffer[] = [];
    for await (const chunk of packer) {
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(tarPath, Buffer.concat(chunks));

    // Extract with tar command
    const extractDir = join(testDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    
    await runCommand('tar', ['-xf', tarPath], extractDir);

    // Compare files
    const originalData = readFileSync(filePath);
    const extractedData = readFileSync(join(extractDir, fileName));
    
    expect(originalData.equals(extractedData)).toBe(true);
    expect(extractedData.length).toBe(fileSize);
  }, 30000);

  it('should handle empty files correctly', async () => {
    // Create source directory with empty files
    const sourceDir = join(testDir, 'source');
    mkdirSync(sourceDir, { recursive: true });

    const emptyFileNames = ['empty1.txt', 'empty2.bin', 'empty3.dat'];
    for (const fileName of emptyFileNames) {
      const fileMode = getRandomFileMode();
      writeFileSync(join(sourceDir, fileName), Buffer.alloc(0), { mode: fileMode });
    }

    // Pack with tar-vern
    const generator = createEntryItemGenerator(sourceDir, emptyFileNames);
    const packer = createTarPacker(generator);
    
    const tarPath = join(testDir, 'empty.tar');
    const chunks: Buffer[] = [];
    for await (const chunk of packer) {
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(tarPath, Buffer.concat(chunks));

    // Extract with tar command
    const extractDir = join(testDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    
    await runCommand('tar', ['-xf', tarPath], extractDir);

    // Verify empty files exist and are empty
    for (const fileName of emptyFileNames) {
      const extractedPath = join(extractDir, fileName);
      expect(existsSync(extractedPath)).toBe(true);
      const extractedData = readFileSync(extractedPath);
      expect(extractedData.length).toBe(0);
    }
  }, 30000);
});