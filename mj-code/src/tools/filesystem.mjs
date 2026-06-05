// Source compatibility shim. The typed filesystem tools now live in ./filesystem.mts.
export {
  listDir,
  previewReplaceInFile,
  previewWriteFile,
  readFile,
  replaceInFile,
  searchFiles,
  writeFile,
} from "./filesystem.mts";
