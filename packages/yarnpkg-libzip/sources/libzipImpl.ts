import {PortablePath}                                                from '@yarnpkg/fslib';
import {Libzip}                                                      from '@yarnpkg/libzip';

import {ZipImplInput, type CompressionData, type Stat, type ZipImpl} from './ZipFS';
import {getInstance}                                                 from './instance';


export class LibzipError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);

    this.name = `Libzip Error`;
    this.code = code;
  }
}

export class LibZipImpl implements ZipImpl {
  private readonly libzip: Libzip;
  private readonly lzSource: number;
  private readonly zip: number;
  private readonly listings: Array<string>;
  private readonly symlinkCount: number;
  private readonly readOnly: boolean;
  private buffer: Buffer | null;

  public readonly filesShouldBeCached;

  constructor(opts: ZipImplInput) {
    this.buffer = `buffer` in opts
      ? opts.buffer
      : opts.baseFs.readFileSync(opts.path);

    this.libzip = getInstance();
    this.readOnly = opts.readOnly === true;
    this.filesShouldBeCached = this.buffer.byteLength >= 10 * 1024 * 1024; // 10MB

    [this.zip, this.lzSource, this.listings, this.symlinkCount] = this.withZip((zip, source) => {
      const entryCount = this.libzip.getNumEntries(zip, 0);
      const listings = new Array<string>(entryCount);
      for (let t = 0; t < entryCount; ++t)
        listings[t] = this.libzip.getName(zip, t, 0);

      const symlinkCount = this.libzip.ext.countSymlinks(zip);
      if (this.symlinkCount === -1)
        throw this.makeLibzipError(this.libzip.getError(zip));

      return [zip, source, listings, symlinkCount];
    });
  }

  /**
   * Calls the function with a valid zip handle and source for the zip.
   *
   * If the instance is read-only, the zip will be transferred into WASM memory
   * for the duration of the function call, and discarded afterwards.
   *
   * If the instance is read-write, the zip will not be freed from WASM until discard is called.
   */
  private withZip<T>(fn: (zip: number, source: number) => T): T {
    const initialized = this.zip !== undefined;
    if (this.readOnly || !initialized) {
      const errPtr = this.libzip.malloc(4);
      try {
        const lzSource = this.allocateUnattachedSource(this.buffer!);
        let zip: number;
        try {
          zip = this.libzip.openFromSource(lzSource, this.readOnly ? this.libzip.ZIP_RDONLY : 0, errPtr);
        } catch (error) {
          this.libzip.source.free(lzSource);
          throw error;
        }

        if (zip === 0) {
          const error = this.libzip.struct.errorS();
          this.libzip.error.initWithCode(error, this.libzip.getValue(errPtr, `i32`));

          const err = this.makeLibzipError(error);
          this.libzip.free(error);
          this.libzip.source.free(lzSource);
          throw err;
        }

        try {
          return fn(zip, lzSource);
        } finally {
          if (this.readOnly) {
            this.libzip.discard(zip);
          }
        }
      } finally {
        this.libzip.free(errPtr);
      }
    } else {
      return fn(this.zip, this.lzSource);
    }
  }

  getSymlinkCount() {
    return this.symlinkCount;
  }

  getListings(): Array<string> {
    return this.listings;
  }

  stat(entry: number): Stat {
    return this.withZip(zip => {
      const stat = this.libzip.struct.statS();

      const rc = this.libzip.statIndex(zip, entry, 0, 0, stat);
      if (rc === -1)
        throw this.makeLibzipError(this.libzip.getError(zip));

      const size = (this.libzip.struct.statSize(stat) >>> 0);
      const mtime = (this.libzip.struct.statMtime(stat) >>> 0);

      const crc = this.libzip.struct.statCrc(stat) >>> 0;

      return {size, mtime, crc};
    });
  }

  makeLibzipError(error: number) {
    const errorCode = this.libzip.struct.errorCodeZip(error);
    const strerror = this.libzip.error.strerror(error);

    const libzipError = new LibzipError(strerror, this.libzip.errors[errorCode]);

    // This error should never come up because of the file source cache
    if (errorCode === this.libzip.errors.ZIP_ER_CHANGED)
      throw new Error(`Assertion failed: Unexpected libzip error: ${libzipError.message}`);

    return libzipError;
  }

  setFileSource(target: PortablePath, compression: CompressionData, buffer: Buffer) {
    return this.withZip(zip => {
      const lzSource = this.allocateSource(zip, buffer);

      try {
        const newIndex = this.libzip.file.add(zip, target, lzSource, this.libzip.ZIP_FL_OVERWRITE);
        if (newIndex === -1)
          throw this.makeLibzipError(this.libzip.getError(zip));

        if (compression !== null) {
          const rc = this.libzip.file.setCompression(zip, newIndex, 0, compression[0], compression[1]);
          if (rc === -1) {
            throw this.makeLibzipError(this.libzip.getError(zip));
          }
        }
        return newIndex;
      } catch (error) {
        this.libzip.source.free(lzSource);
        throw error;
      }
    });
  }

  setMtime(entry: number, mtime: number): void {
    return this.withZip(zip => {
      const rc = this.libzip.file.setMtime(zip, entry, 0, mtime, 0);
      if (rc === -1) {
        throw this.makeLibzipError(this.libzip.getError(zip));
      }
    });
  }

  getExternalAttributes(index: number): [number, number] {
    return this.withZip(zip => {
      const attrs = this.libzip.file.getExternalAttributes(zip, index, 0, 0, this.libzip.uint08S, this.libzip.uint32S);
      if (attrs === -1)
        throw this.makeLibzipError(this.libzip.getError(zip));

      const opsys = this.libzip.getValue(this.libzip.uint08S, `i8`) >>> 0;
      const attributes = this.libzip.getValue(this.libzip.uint32S, `i32`) >>> 0;
      return [opsys, attributes];
    });
  }

  setExternalAttributes(index: number, opsys: number, attributes: number): void {
    return this.withZip(zip => {
      const rc = this.libzip.file.setExternalAttributes(zip, index, 0, 0, opsys, attributes);
      if (rc === -1) {
        throw this.makeLibzipError(this.libzip.getError(zip));
      }
    });
  }

  locate(name: string): number {
    return this.withZip(zip => {
      return this.libzip.name.locate(zip, name, 0);
    });
  }

  getFileSource(index: number) {
    return this.withZip(zip => {
      const stat = this.libzip.struct.statS();

      const rc = this.libzip.statIndex(zip, index, 0, 0, stat);
      if (rc === -1)
        throw this.makeLibzipError(this.libzip.getError(zip));

      const size = this.libzip.struct.statCompSize(stat);
      const compressionMethod = this.libzip.struct.statCompMethod(stat);
      const buffer = this.libzip.malloc(size);

      try {
        const file = this.libzip.fopenIndex(zip, index, 0, this.libzip.ZIP_FL_COMPRESSED);
        if (file === 0)
          throw this.makeLibzipError(this.libzip.getError(zip));

        try {
          const rc = this.libzip.fread(file, buffer, size, 0);

          if (rc === -1)
            throw this.makeLibzipError(this.libzip.file.getError(file));
          else if (rc < size)
            throw new Error(`Incomplete read`);
          else if (rc > size)
            throw new Error(`Overread`);

          const memory = this.libzip.HEAPU8.subarray(buffer, buffer + size);
          const data = Buffer.from(memory);

          return {data, compressionMethod};
        } finally {
          this.libzip.fclose(file);
        }
      } finally {
        this.libzip.free(buffer);
      }
    });
  }

  deleteEntry(index: number) {
    return this.withZip(zip => {
      const rc = this.libzip.delete(zip, index);
      if (rc === -1) {
        throw this.makeLibzipError(this.libzip.getError(zip));
      }
    });
  }

  addDirectory(path: string): number {
    return this.withZip(zip => {
      const index = this.libzip.dir.add(zip, path);
      if (index === -1)
        throw this.makeLibzipError(this.libzip.getError(zip));

      return index;
    });
  }

  getBufferAndClose() {
    return this.withZip((zip, source) => {
      try {
        // Prevent close from cleaning up the source
        this.libzip.source.keep(source);

        // Close the zip archive
        if (this.libzip.close(zip) === -1)
          throw this.makeLibzipError(this.libzip.getError(zip));

        // Open the source for reading
        if (this.libzip.source.open(source) === -1)
          throw this.makeLibzipError(this.libzip.source.error(source));

        // Move to the end of source
        if (this.libzip.source.seek(source, 0, 0, this.libzip.SEEK_END) === -1)
          throw this.makeLibzipError(this.libzip.source.error(source));

        // Get the size of source
        const size = this.libzip.source.tell(source);
        if (size === -1)
          throw this.makeLibzipError(this.libzip.source.error(source));

        // Move to the start of source
        if (this.libzip.source.seek(source, 0, 0, this.libzip.SEEK_SET) === -1)
          throw this.makeLibzipError(this.libzip.source.error(source));

        const buffer = this.libzip.malloc(size);
        if (!buffer)
          throw new Error(`Couldn't allocate enough memory`);

        try {
          const rc = this.libzip.source.read(source, buffer, size);

          if (rc === -1)
            throw this.makeLibzipError(this.libzip.source.error(source));
          else if (rc < size)
            throw new Error(`Incomplete read`);
          else if (rc > size)
            throw new Error(`Overread`);

          let result = Buffer.from(this.libzip.HEAPU8.subarray(buffer, buffer + size));

          if (process.env.YARN_IS_TEST_ENV && process.env.YARN_ZIP_DATA_EPILOGUE)
            result = Buffer.concat([result, Buffer.from(process.env.YARN_ZIP_DATA_EPILOGUE)]);

          return result;
        } finally {
          this.libzip.free(buffer);
        }
      } finally {
        this.libzip.source.close(source);
        this.libzip.source.free(source);
      }
    });
  }

  private allocateBuffer(content: string | Buffer | ArrayBuffer | DataView) {
    if (!Buffer.isBuffer(content))
      content = Buffer.from(content as any);

    const buffer = this.libzip.malloc(content.byteLength);
    if (!buffer)
      throw new Error(`Couldn't allocate enough memory`);

    // Copy the file into the Emscripten heap
    const heap = new Uint8Array(this.libzip.HEAPU8.buffer, buffer, content.byteLength);
    heap.set(content as any);

    return {buffer, byteLength: content.byteLength};
  }

  private allocateUnattachedSource(content: string | Buffer | ArrayBuffer | DataView) {
    const error = this.libzip.struct.errorS();

    const {buffer, byteLength} = this.allocateBuffer(content);
    const source = this.libzip.source.fromUnattachedBuffer(buffer, byteLength, 0, 1, error);

    if (source === 0) {
      this.libzip.free(error);
      this.libzip.free(buffer);
      throw this.makeLibzipError(error);
    }

    return source;
  }

  private allocateSource(zip: number, content: string | Buffer | ArrayBuffer | DataView) {
    const {buffer, byteLength} = this.allocateBuffer(content);
    const source = this.libzip.source.fromBuffer(zip, buffer, byteLength, 0, 1);

    if (source === 0) {
      this.libzip.free(buffer);
      throw this.makeLibzipError(this.libzip.getError(zip));
    }

    return source;
  }

  public discard(): void {
    if (!this.readOnly)
      this.libzip.discard(this.zip);

    this.buffer = null;
  }
}
