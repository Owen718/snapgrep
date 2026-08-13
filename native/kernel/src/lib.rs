//! Persistent mmap literal-search core for pi-fast-grep.
//!
//! The core deliberately has a narrow, typed contract:
//! - the caller supplies the exact repository-relative UTF-8 file universe;
//! - single-line literals of at least three UTF-8 bytes are accepted, with an
//!   ASCII-only case-fold mode that fails closed around Unicode folds;
//! - ASCII identifier trigrams are a recall-safe candidate filter, while the
//!   immutable persisted file blocks provide the final exact, leftmost non-overlapping
//!   verification; literals without an indexed trigram scan every file block;
//! - any exact match in a NUL-containing file is reported as requiring a
//!   ripgrep fallback instead of being silently included or dropped.
//!
//! Ignore files, path/glob semantics, dirty generations, line aggregation,
//! context, and N-API ownership intentionally live above this crate.

// napi-rs generates the small unsafe Node-API conversion shim. The hand-written
// binding remains safe Rust; the mmap's only hand-written unsafe block stays in
// map_index_read_only below with its generation-ownership invariant.
#[allow(unsafe_code)]
#[cfg_attr(test, allow(dead_code))]
mod binding;
mod regex_plan;

use std::borrow::Cow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use memchr::{memchr, memmem};
use memmap2::{Mmap, MmapOptions};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

const MAGIC: &[u8; 8] = b"PFGKIDX1";
const FORMAT_VERSION_V1: u32 = 1;
const FORMAT_VERSION_V2: u32 = 2;
const FORMAT_VERSION_V3: u32 = 3;
const FORMAT_VERSION_V4: u32 = 4;
const FORMAT_VERSION_V5: u32 = 5;
const HEADER_LEN: usize = 256;
const HEADER_LEN_U32: u32 = 256;
const FILE_RECORD_LEN: usize = 48;
const GRAM_RECORD_LEN: usize = 24;
const COMPACT_GRAM_RECORD_LEN: usize = 12;
const FLAG_BINARY: u32 = 1;
const FLAG_COMPRESSED: u32 = 1 << 1;
const NO_NUL: u64 = u64::MAX;
const PAYLOAD_CHECKSUM_OFFSET: usize = 136;
const HEADER_CHECKSUM_OFFSET: usize = 168;
const CHECKSUM_LEN: usize = 32;
const SOURCE_DIGEST_BUFFER_LEN: usize = 64 * 1024;
const INDEX_WRITE_BUFFER_LEN: usize = 64 * 1024;

/// Errors are typed so the future N-API layer can distinguish unsupported
/// queries from corrupt/stale indexes and ordinary I/O failures.
#[derive(Debug, Error)]
pub enum KernelError {
    #[error("unsupported literal: {0}")]
    UnsupportedLiteral(&'static str),
    #[error("regex verification is unsupported: {0}")]
    UnsupportedRegex(String),
    #[error("regex verification was aborted")]
    Aborted,
    #[error("invalid relative path `{path}`: {reason}")]
    InvalidRelativePath { path: String, reason: &'static str },
    #[error("source file changed while the index was being built: {0}")]
    SourceChanged(String),
    #[error("index is corrupt: {0}")]
    Corrupt(String),
    #[error("index is too large for this process")]
    TooLarge,
    #[error("operation is unsupported on this platform: {0}")]
    UnsupportedPlatform(&'static str),
    #[error("I/O error while {operation} `{path}`: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Stable build statistics. Durations are diagnostic and never participate
/// in index identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildStats {
    pub format_version: u32,
    pub files: u64,
    pub binary_files: u64,
    pub grams: u64,
    pub postings: u64,
    pub index_bytes: u64,
    pub build_duration: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BuildWithSourceDigest {
    pub stats: BuildStats,
    pub content_sha256: String,
    pub source_bytes: u64,
}

struct BuildOutcome {
    stats: BuildStats,
    content_sha256: Option<String>,
    source_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenStats {
    pub format_version: u32,
    pub files: u64,
    pub binary_files: u64,
    pub grams: u64,
    pub postings: u64,
    pub index_bytes: u64,
    pub open_duration: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Occurrence {
    pub path: String,
    pub absolute_start: u64,
    pub absolute_end: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryResult {
    pub occurrences: Vec<Occurrence>,
    pub total_occurrences: u64,
    pub candidate_files: u64,
    pub binary_match_files: Vec<String>,
    pub utf8_bom_candidate_files: Vec<String>,
    pub transcoded_candidate_files: Vec<String>,
    pub unsafe_transcoded_files: Vec<String>,
    pub unsafe_case_fold_files: Vec<String>,
    pub requires_fallback: bool,
    pub truncated: bool,
    pub query_duration: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegexCandidateResult {
    pub selected_gram: u32,
    pub mandatory_grams: u64,
    pub candidate_paths: Vec<String>,
    pub candidate_files: u64,
    pub binary_candidate_paths: Vec<String>,
    /// Valid UTF-8 BOM candidates that the in-process verifier can search
    /// with ripgrep-compatible decoded offsets.
    pub utf8_bom_candidate_paths: Vec<String>,
    /// Safe transcoded candidates that still require external ripgrep.
    pub transcoded_candidate_paths: Vec<String>,
    pub unsafe_transcoded_paths: Vec<String>,
    pub query_duration: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedRange {
    pub absolute_start: u64,
    pub absolute_end: u64,
    pub line_start: u64,
    pub line_end: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedMatch {
    pub path: String,
    pub line_number: u64,
    pub line_text: String,
    pub ranges: Vec<VerifiedRange>,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegexVerifyResult {
    pub matches: Vec<VerifiedMatch>,
    pub total_matches: u64,
    pub verified_files: u64,
    pub truncated: bool,
    pub query_duration: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiteralVerifyResult {
    pub matches: Vec<VerifiedMatch>,
    pub total_matches: u64,
    pub total_occurrences: u64,
    pub indexed_occurrences: u64,
    pub verified_files: u64,
    pub truncated: bool,
    pub query_duration: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceContentDigest {
    pub content_sha256: String,
    pub files: u64,
    pub source_bytes: u64,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StableFileId {
    dev: u64,
    ino: u64,
}

#[cfg(not(unix))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StableFileId;

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StableSourceIdentity {
    file_id: StableFileId,
    len: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[cfg(not(unix))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StableSourceIdentity {
    file_id: StableFileId,
    len: u64,
    modified: Option<SystemTime>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceDigestPhase {
    PathValidated,
    Opened,
    FirstChunk,
    ReadComplete,
}

pub(crate) struct SourceContentDigester {
    root: PathBuf,
    canonical_root: PathBuf,
    root_file_id: StableFileId,
    beneath_root: Option<File>,
    hasher: Sha256,
    buffer: Box<[u8]>,
    files: u64,
    source_bytes: u64,
}

impl SourceContentDigester {
    pub(crate) fn new(
        root: impl AsRef<Path>,
        expected_canonical_root: impl AsRef<Path>,
    ) -> Result<Self, KernelError> {
        #[cfg(not(unix))]
        return Err(KernelError::UnsupportedPlatform(
            "native source digest requires stable device and inode identity",
        ));

        #[cfg(unix)]
        {
            let root = absolute_lexical(root.as_ref())?;
            let canonical_root = fs::canonicalize(&root)
                .map_err(|source| io_error("canonicalizing repository root", &root, source))?;
            if canonical_root != expected_canonical_root.as_ref() {
                return Err(KernelError::SourceChanged(
                    "repository root changed before source digest".into(),
                ));
            }
            let root_metadata = fs::metadata(&canonical_root).map_err(|source| {
                io_error("reading repository root metadata", &canonical_root, source)
            })?;
            if !root_metadata.is_dir() {
                return Err(KernelError::SourceChanged(
                    "repository root is no longer a directory".into(),
                ));
            }
            let root_file_id = stable_file_id(&root_metadata);
            Ok(Self {
                root,
                beneath_root: prepare_beneath_root(&canonical_root, root_file_id)?,
                canonical_root,
                root_file_id,
                hasher: Sha256::new(),
                buffer: vec![0; SOURCE_DIGEST_BUFFER_LEN].into_boxed_slice(),
                files: 0,
                source_bytes: 0,
            })
        }
    }

    #[cfg(test)]
    pub(crate) fn add(&mut self, relative_path: &str) -> Result<(), KernelError> {
        self.add_with_post_read_validation(relative_path, true)
    }

    /// The caller must be the synchronous isolated Agent-loop start seam: no
    /// external writer exists, and every legal mutator is fenced before start.
    /// Initial containment/open identity and the final root fence still apply.
    pub(crate) fn add_isolated_trusted(&mut self, relative_path: &str) -> Result<(), KernelError> {
        self.add_with_post_read_validation(relative_path, false)
    }

    fn add_with_post_read_validation(
        &mut self,
        relative_path: &str,
        verify_after_read: bool,
    ) -> Result<(), KernelError> {
        #[cfg(test)]
        {
            self.add_impl(relative_path, verify_after_read, &mut |_, _| Ok(()))
        }
        #[cfg(not(test))]
        {
            self.add_impl(relative_path, verify_after_read)
        }
    }

    #[cfg(test)]
    fn add_with_phase_hook(
        &mut self,
        relative_path: &str,
        mut phase_hook: impl FnMut(SourceDigestPhase, &Path) -> Result<(), KernelError>,
    ) -> Result<(), KernelError> {
        self.add_impl(relative_path, true, &mut phase_hook)
    }

    #[cfg(test)]
    fn add_isolated_trusted_with_phase_hook(
        &mut self,
        relative_path: &str,
        mut phase_hook: impl FnMut(SourceDigestPhase, &Path) -> Result<(), KernelError>,
    ) -> Result<(), KernelError> {
        self.add_impl(relative_path, false, &mut phase_hook)
    }

    fn add_impl(
        &mut self,
        relative_path: &str,
        verify_after_read: bool,
        #[cfg(test)] phase_hook: &mut dyn FnMut(
            SourceDigestPhase,
            &Path,
        ) -> Result<(), KernelError>,
    ) -> Result<(), KernelError> {
        validate_relative_path(relative_path)?;
        let joined = self
            .root
            .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let (mut file, before_handle, before_path, canonical_file) = self.open_source_for_digest(
            relative_path,
            &joined,
            verify_after_read,
            #[cfg(test)]
            phase_hook,
        )?;
        #[cfg(test)]
        phase_hook(SourceDigestPhase::Opened, &joined)?;

        update_sha256_length_prefix(
            &mut self.hasher,
            u64::try_from(relative_path.len()).map_err(|_| KernelError::TooLarge)?,
        );
        self.hasher.update(relative_path.as_bytes());
        update_sha256_length_prefix(&mut self.hasher, before_handle.len());

        let mut bytes_read = 0u64;
        #[cfg(test)]
        let mut first_chunk = true;
        loop {
            let read = file
                .read(&mut self.buffer)
                .map_err(|source| io_error("reading source file", &canonical_file, source))?;
            if read == 0 {
                break;
            }
            self.hasher.update(&self.buffer[..read]);
            #[cfg(test)]
            if first_chunk {
                phase_hook(SourceDigestPhase::FirstChunk, &joined)?;
                first_chunk = false;
            }
            bytes_read = checked_add(
                bytes_read,
                u64::try_from(read).map_err(|_| KernelError::TooLarge)?,
            )?;
            if bytes_read > before_handle.len() {
                return Err(KernelError::SourceChanged(relative_path.to_owned()));
            }
        }
        #[cfg(test)]
        phase_hook(SourceDigestPhase::ReadComplete, &joined)?;

        if bytes_read != before_handle.len() {
            return Err(KernelError::SourceChanged(relative_path.to_owned()));
        }
        if verify_after_read {
            let Some(before_path) = before_path.as_ref() else {
                return Err(KernelError::SourceChanged(relative_path.to_owned()));
            };
            let after_handle = file
                .metadata()
                .map_err(|source| io_error("reading source metadata", &canonical_file, source))?;
            let after_path = fs::symlink_metadata(&joined)
                .map_err(|source| io_error("reading source metadata", &joined, source))?;
            let after_canonical = fs::canonicalize(&joined)
                .map_err(|source| io_error("canonicalizing source file", &joined, source))?;
            let expected_identity = stable_source_identity(&before_handle);
            if after_path.file_type().is_symlink()
                || !after_path.is_file()
                || canonical_file != after_canonical
                || !after_canonical.starts_with(&self.canonical_root)
                || stable_source_identity(before_path) != expected_identity
                || stable_source_identity(&after_handle) != expected_identity
                || stable_source_identity(&after_path) != expected_identity
            {
                return Err(KernelError::SourceChanged(relative_path.to_owned()));
            }
        }

        self.files = checked_add(self.files, 1)?;
        self.source_bytes = checked_add(self.source_bytes, bytes_read)?;
        Ok(())
    }

    fn open_source_for_digest(
        &self,
        relative_path: &str,
        joined: &Path,
        verify_after_read: bool,
        #[cfg(test)] phase_hook: &mut dyn FnMut(
            SourceDigestPhase,
            &Path,
        ) -> Result<(), KernelError>,
    ) -> Result<(File, Metadata, Option<Metadata>, PathBuf), KernelError> {
        let attempted_beneath = !verify_after_read && self.beneath_root.is_some();
        // The test seam deliberately runs before the atomic beneath-root open:
        // a retarget here must be rejected by the open itself, not by a cached
        // authorization from the preceding path.
        #[cfg(test)]
        if attempted_beneath {
            phase_hook(SourceDigestPhase::PathValidated, joined)?;
        }
        if attempted_beneath {
            let root = self
                .beneath_root
                .as_ref()
                .ok_or(KernelError::UnsupportedPlatform(
                    "beneath-root capability disappeared",
                ))?;
            let file = open_source_beneath(root, relative_path)
                .map_err(|source| beneath_open_error(relative_path, joined, source))?;
            let before_handle = file
                .metadata()
                .map_err(|source| io_error("reading source metadata", joined, source))?;
            if !before_handle.is_file() {
                return Err(KernelError::InvalidRelativePath {
                    path: relative_path.to_owned(),
                    reason: "path is not a regular non-symlink file",
                });
            }
            return Ok((file, before_handle, None, joined.to_path_buf()));
        }

        // Preserve the exact legacy behavior for strict callers and kernels
        // whose semantic capability probe did not pass.
        let before_path = fs::symlink_metadata(joined)
            .map_err(|source| io_error("reading source metadata", joined, source))?;
        if before_path.file_type().is_symlink() || !before_path.is_file() {
            return Err(KernelError::InvalidRelativePath {
                path: relative_path.to_owned(),
                reason: "path is not a regular non-symlink file",
            });
        }
        let canonical_file = fs::canonicalize(joined)
            .map_err(|source| io_error("canonicalizing source file", joined, source))?;
        if !canonical_file.starts_with(&self.canonical_root) {
            return Err(KernelError::InvalidRelativePath {
                path: relative_path.to_owned(),
                reason: "canonical path escapes the repository root",
            });
        }
        #[cfg(test)]
        phase_hook(SourceDigestPhase::PathValidated, joined)?;
        let file = open_source_no_follow(joined)?;
        let before_handle = file
            .metadata()
            .map_err(|source| io_error("reading source metadata", &canonical_file, source))?;
        if !before_handle.is_file()
            || stable_source_identity(&before_path) != stable_source_identity(&before_handle)
        {
            return Err(KernelError::SourceChanged(relative_path.to_owned()));
        }
        Ok((file, before_handle, Some(before_path), canonical_file))
    }

    pub(crate) fn finish(self) -> Result<SourceContentDigest, KernelError> {
        let final_canonical_root = fs::canonicalize(&self.root)
            .map_err(|source| io_error("canonicalizing repository root", &self.root, source))?;
        let final_root_metadata = fs::metadata(&final_canonical_root).map_err(|source| {
            io_error(
                "reading repository root metadata",
                &final_canonical_root,
                source,
            )
        })?;
        if final_canonical_root != self.canonical_root
            || !final_root_metadata.is_dir()
            || stable_file_id(&final_root_metadata) != self.root_file_id
        {
            return Err(KernelError::SourceChanged(
                "repository root changed during source digest".into(),
            ));
        }
        let digest = self.hasher.finalize();
        Ok(SourceContentDigest {
            content_sha256: format!("{digest:x}"),
            files: self.files,
            source_bytes: self.source_bytes,
        })
    }
}

#[derive(Clone, Debug)]
struct SourceFile {
    relative_path: String,
    absolute_path: PathBuf,
    path_offset: u64,
    content_offset: u64,
    content_len: u64,
    stored_len: u64,
    compressed: bool,
    content_checksum: [u8; CHECKSUM_LEN],
    first_nul: Option<u64>,
    snapshot: SourceSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceSnapshot {
    len: u64,
    modified: Option<SystemTime>,
}

struct TrustedBuildRoot {
    root: File,
    original_root: PathBuf,
    canonical_root: PathBuf,
    root_file_id: StableFileId,
    resolved_index: PathBuf,
    index_leaf: OsString,
}

#[derive(Clone, Copy, Debug)]
struct Header {
    format_version: u32,
    file_count: u64,
    gram_count: u64,
    posting_count: u64,
    binary_file_count: u64,
    file_table_offset: u64,
    file_table_len: u64,
    gram_table_offset: u64,
    gram_table_len: u64,
    postings_offset: u64,
    postings_len: u64,
    paths_offset: u64,
    paths_len: u64,
    contents_offset: u64,
    contents_len: u64,
    total_len: u64,
    payload_checksum: [u8; CHECKSUM_LEN],
}

#[derive(Clone, Copy, Debug)]
struct FileRecord {
    path_offset: u64,
    path_len: u32,
    flags: u32,
    content_offset: u64,
    content_len: u64,
    first_nul: u64,
    stored_len: u64,
}

#[derive(Default)]
struct TranscodedFileIds {
    safe: Vec<u32>,
    utf8_bom: Vec<u32>,
    decoded_nul: Vec<u32>,
}

#[derive(Default)]
struct UnicodeAsciiFoldFileIds {
    kelvin_sign: Vec<u32>,
    long_s: Vec<u32>,
}

#[derive(Clone, Copy, Debug)]
struct GramRecord {
    key: u32,
    postings_offset: u64,
    postings_count: u64,
}

struct CompactPostingData {
    records: Vec<GramRecord>,
    gram_bytes: Vec<u8>,
    bytes: Vec<u8>,
}

struct ValidatedPayload {
    transcoded_file_ids: TranscodedFileIds,
    unicode_ascii_fold_file_ids: UnicodeAsciiFoldFileIds,
    variable_gram_records: Option<Vec<GramRecord>>,
}

/// A validated, immutable memory mapping. It holds no sidecar process and can
/// be dropped and reopened by another Node/Pi process.
pub struct KernelIndex {
    mmap: Mmap,
    header: Header,
    transcoded_file_ids: TranscodedFileIds,
    unicode_ascii_fold_file_ids: UnicodeAsciiFoldFileIds,
    variable_gram_records: Option<Vec<GramRecord>>,
}

impl KernelIndex {
    /// Open and fully validate an index before it can answer a query.
    ///
    /// Every supported format validates the whole payload checksum. This is intentionally
    /// fail-closed; a later format may replace the linear checksum with a
    /// block/Merkle scheme if large-repository warm-open measurements require
    /// it.
    ///
    /// # Errors
    ///
    /// Returns [`KernelError::Corrupt`] for any invalid header, checksum,
    /// section, record, or posting; [`KernelError::Io`] for open/map failures.
    pub fn open(index_path: impl AsRef<Path>) -> Result<(Self, OpenStats), KernelError> {
        let started = Instant::now();
        let index_path = index_path.as_ref();
        let file = File::open(index_path)
            .map_err(|source| io_error("opening index", index_path, source))?;
        let metadata = file
            .metadata()
            .map_err(|source| io_error("reading index metadata", index_path, source))?;
        let file_len = usize::try_from(metadata.len()).map_err(|_| KernelError::TooLarge)?;
        if file_len < HEADER_LEN {
            return Err(KernelError::Corrupt(
                "file is shorter than the fixed header".into(),
            ));
        }

        let mmap = map_index_read_only(&file, file_len)
            .map_err(|source| io_error("memory-mapping index", index_path, source))?;
        let header = decode_and_validate_header(&mmap)?;
        let validated = validate_payload(&mmap, header)?;
        let index = Self {
            mmap,
            header,
            transcoded_file_ids: validated.transcoded_file_ids,
            unicode_ascii_fold_file_ids: validated.unicode_ascii_fold_file_ids,
            variable_gram_records: validated.variable_gram_records,
        };
        let stats = OpenStats {
            format_version: header.format_version,
            files: header.file_count,
            binary_files: header.binary_file_count,
            grams: header.gram_count,
            postings: header.posting_count,
            index_bytes: header.total_len,
            open_duration: started.elapsed(),
        };
        Ok((index, stats))
    }

    #[must_use]
    pub fn file_count(&self) -> u64 {
        self.header.file_count
    }

    #[must_use]
    pub fn binary_file_count(&self) -> u64 {
        self.header.binary_file_count
    }

    #[must_use]
    pub fn index_bytes(&self) -> u64 {
        self.header.total_len
    }

    /// Search the immutable snapshot using a recall-safe trigram candidate.
    ///
    /// Results are occurrence-level and ordered by UTF-8 path bytes then
    /// absolute byte offset. `occurrence_limit` is deliberately not the public
    /// `SearchRequest.limit`, whose unit is matching lines. Product callers
    /// must pass `None`, then aggregate into ripgrep-compatible match lines,
    /// apply JS UTF-16 path ordering, and apply the line limit at that boundary.
    ///
    /// # Errors
    ///
    /// Returns [`KernelError::UnsupportedLiteral`] outside the v1 literal
    /// subset and fails closed if a previously validated record cannot be read.
    pub fn query_literal(
        &self,
        literal: &str,
        occurrence_limit: Option<usize>,
    ) -> Result<QueryResult, KernelError> {
        self.query_literal_in_path(literal, None, occurrence_limit)
    }

    /// Search a validated repository-relative file or directory subtree.
    /// `path_root` uses POSIX separators and is matched as either an exact file
    /// path or a complete directory prefix.
    pub fn query_literal_in_path(
        &self,
        literal: &str,
        path_root: Option<&str>,
        occurrence_limit: Option<usize>,
    ) -> Result<QueryResult, KernelError> {
        self.query_literal_with_filters(literal, path_root, None, false, occurrence_limit)
    }

    /// Search with validated repository-relative path and glob filters.
    ///
    /// The glob subset is deliberately narrow: literal bytes and `*` within a
    /// path segment, plus a non-final complete `**` segment. Patterns without
    /// `/` match basenames at any depth; patterns with `/` are root-anchored.
    pub fn query_literal_with_filters(
        &self,
        literal: &str,
        path_root: Option<&str>,
        glob_pattern: Option<&str>,
        ignore_ascii_case: bool,
        occurrence_limit: Option<usize>,
    ) -> Result<QueryResult, KernelError> {
        validate_literal(literal)?;
        if ignore_ascii_case && !literal.is_ascii() {
            return Err(KernelError::UnsupportedLiteral(
                "case-folded literal is not ASCII",
            ));
        }
        if let Some(path_root) = path_root {
            validate_relative_path(path_root)?;
        }
        let started = Instant::now();
        let glob_matcher = glob_pattern.map(LiteralGlob::compile).transpose()?;
        let needle = literal.as_bytes();
        let filter_paths = |file_ids: &[u32]| -> Result<Vec<String>, KernelError> {
            let paths = self.paths_for_file_ids(file_ids)?;
            Ok(if path_root.is_none() && glob_matcher.is_none() {
                paths
            } else {
                paths
                    .into_iter()
                    .filter(|path| path_matches_filters(path, path_root, glob_matcher.as_ref()))
                    .collect()
            })
        };
        let utf8_bom_candidate_files = filter_paths(&self.transcoded_file_ids.utf8_bom)?;
        let transcoded_candidate_files = filter_paths(&self.transcoded_file_ids.safe)?;
        let unsafe_transcoded_files = filter_paths(&self.transcoded_file_ids.decoded_nul)?;

        let unsafe_case_fold_files = if ignore_ascii_case {
            let mut file_ids = Vec::new();
            if needle.iter().any(|byte| byte.eq_ignore_ascii_case(&b'k')) {
                file_ids.extend_from_slice(&self.unicode_ascii_fold_file_ids.kelvin_sign);
            }
            if needle.iter().any(|byte| byte.eq_ignore_ascii_case(&b's')) {
                file_ids.extend_from_slice(&self.unicode_ascii_fold_file_ids.long_s);
            }
            file_ids.sort_unstable();
            file_ids.dedup();
            filter_paths(&file_ids)?
        } else {
            Vec::new()
        };

        let candidate_file_ids = if ignore_ascii_case {
            self.ascii_case_fold_candidate_ids(needle)?
        } else {
            let mut unique_grams = needle
                .windows(3)
                .map(pack_gram)
                .filter(|gram| is_indexed_gram(*gram))
                .collect::<Vec<_>>();
            unique_grams.sort_unstable();
            unique_grams.dedup();

            let mut selected: Option<GramRecord> = None;
            for gram in unique_grams {
                let Some(record) = self.find_gram(gram)? else {
                    return Ok(QueryResult {
                        occurrences: Vec::new(),
                        total_occurrences: 0,
                        candidate_files: 0,
                        binary_match_files: Vec::new(),
                        utf8_bom_candidate_files,
                        transcoded_candidate_files,
                        requires_fallback: !unsafe_transcoded_files.is_empty()
                            || !unsafe_case_fold_files.is_empty(),
                        unsafe_transcoded_files,
                        unsafe_case_fold_files,
                        truncated: false,
                        query_duration: started.elapsed(),
                    });
                };
                if selected.is_none_or(|current| record.postings_count < current.postings_count) {
                    selected = Some(record);
                }
            }

            // The gram vocabulary is intentionally sparse. A literal with no
            // indexed identifier trigram must scan every immutable file instead
            // of treating an omitted gram as proof of absence.
            if let Some(gram) = selected {
                self.posting_ids(gram)?
            } else {
                self.all_file_ids()?
            }
        };
        let mut occurrences = Vec::new();
        let mut binary_match_files = Vec::new();
        let finder = LiteralFinder::new(needle, ignore_ascii_case);
        let mut scan_record = |record: FileRecord, path: &str| -> Result<(), KernelError> {
            let content = self.content(record)?;
            let is_binary = record.flags & FLAG_BINARY != 0;

            let mut cursor = 0usize;
            let mut binary_matched = false;
            while cursor <= content.len().saturating_sub(needle.len()) {
                let Some(relative) = finder.find(&content[cursor..]) else {
                    break;
                };
                let start = cursor.checked_add(relative).ok_or(KernelError::TooLarge)?;
                let end = start
                    .checked_add(needle.len())
                    .ok_or(KernelError::TooLarge)?;
                if is_binary {
                    binary_matched = true;
                    break;
                }
                occurrences.push(Occurrence {
                    path: path.to_owned(),
                    absolute_start: u64::try_from(start).map_err(|_| KernelError::TooLarge)?,
                    absolute_end: u64::try_from(end).map_err(|_| KernelError::TooLarge)?,
                });
                cursor = end;
            }
            if binary_matched {
                binary_match_files.push(path.to_owned());
            }
            Ok(())
        };
        let candidate_count = if path_root.is_some() || glob_matcher.is_some() {
            let mut count = 0u64;
            for file_id in candidate_file_ids {
                let record = self.file_record(u64::from(file_id))?;
                let path = self.path(record)?;
                if !path_matches_filters(path, path_root, glob_matcher.as_ref()) {
                    continue;
                }
                count = checked_add(count, 1)?;
                if self.is_transcoded_file_id(file_id) {
                    continue;
                }
                scan_record(record, path)?;
            }
            count
        } else {
            let count =
                u64::try_from(candidate_file_ids.len()).map_err(|_| KernelError::TooLarge)?;
            for file_id in candidate_file_ids {
                if self.is_transcoded_file_id(file_id) {
                    continue;
                }
                let record = self.file_record(u64::from(file_id))?;
                let content = self.content(record)?;
                let path = self.path(record)?;
                let is_binary = record.flags & FLAG_BINARY != 0;

                let mut cursor = 0usize;
                let mut binary_matched = false;
                while cursor <= content.len().saturating_sub(needle.len()) {
                    let Some(relative) = finder.find(&content[cursor..]) else {
                        break;
                    };
                    let start = cursor.checked_add(relative).ok_or(KernelError::TooLarge)?;
                    let end = start
                        .checked_add(needle.len())
                        .ok_or(KernelError::TooLarge)?;
                    if is_binary {
                        binary_matched = true;
                        break;
                    }
                    occurrences.push(Occurrence {
                        path: path.to_owned(),
                        absolute_start: u64::try_from(start).map_err(|_| KernelError::TooLarge)?,
                        absolute_end: u64::try_from(end).map_err(|_| KernelError::TooLarge)?,
                    });
                    cursor = end;
                }
                if binary_matched {
                    binary_match_files.push(path.to_owned());
                }
            }
            count
        };

        let total_occurrences =
            u64::try_from(occurrences.len()).map_err(|_| KernelError::TooLarge)?;
        let keep = occurrence_limit
            .unwrap_or(occurrences.len())
            .min(occurrences.len());
        occurrences.truncate(keep);
        let truncated = u64::try_from(keep).map_err(|_| KernelError::TooLarge)? < total_occurrences;
        Ok(QueryResult {
            occurrences,
            total_occurrences,
            candidate_files: candidate_count,
            requires_fallback: !binary_match_files.is_empty()
                || !unsafe_transcoded_files.is_empty()
                || !unsafe_case_fold_files.is_empty(),
            binary_match_files,
            utf8_bom_candidate_files,
            transcoded_candidate_files,
            unsafe_transcoded_files,
            unsafe_case_fold_files,
            truncated,
            query_duration: started.elapsed(),
        })
    }

    fn all_file_ids(&self) -> Result<Vec<u32>, KernelError> {
        (0..self.header.file_count)
            .map(|file_id| u32::try_from(file_id).map_err(|_| KernelError::TooLarge))
            .collect()
    }

    fn ascii_case_fold_candidate_ids(&self, needle: &[u8]) -> Result<Vec<u32>, KernelError> {
        let mut logical_grams = needle
            .windows(3)
            .map(|gram| {
                pack_gram(&[
                    gram[0].to_ascii_lowercase(),
                    gram[1].to_ascii_lowercase(),
                    gram[2].to_ascii_lowercase(),
                ])
            })
            .filter(|gram| is_indexed_gram(*gram))
            .collect::<Vec<_>>();
        logical_grams.sort_unstable();
        logical_grams.dedup();

        let mut selected: Option<Vec<u32>> = None;
        for logical_gram in logical_grams {
            let bytes = logical_gram.to_be_bytes();
            let mut union = Vec::new();
            for variant in ascii_case_gram_variants([bytes[1], bytes[2], bytes[3]]) {
                if let Some(record) = self.find_gram(pack_gram(&variant))? {
                    union.extend(self.posting_ids(record)?);
                }
            }
            union.sort_unstable();
            union.dedup();
            if union.is_empty() {
                return Ok(union);
            }
            if selected
                .as_ref()
                .is_none_or(|current| union.len() < current.len())
            {
                selected = Some(union);
            }
        }
        match selected {
            Some(file_ids) => Ok(file_ids),
            None => self.all_file_ids(),
        }
    }

    /// Materialize exact literal matching lines from a JS-ordered subset of
    /// ordinary indexed files. Every candidate is scanned to keep matching-line
    /// and occurrence totals exact; a finite limit bounds only returned lines.
    ///
    /// # Errors
    ///
    /// Fails closed for unsupported literals, duplicate/out-of-order/non-indexed
    /// candidates, binary/transcoded content, bare CR lines, corruption, or
    /// cooperative cancellation.
    pub fn verify_literal_candidates(
        &self,
        literal: &str,
        ignore_ascii_case: bool,
        candidate_paths: &[String],
        before_count: usize,
        after_count: usize,
        match_limit: Option<usize>,
        cancelled: &AtomicBool,
    ) -> Result<LiteralVerifyResult, KernelError> {
        validate_literal(literal)?;
        if ignore_ascii_case && !literal.is_ascii() {
            return Err(KernelError::UnsupportedLiteral(
                "case-folded literal is not ASCII",
            ));
        }
        let started = Instant::now();
        for pair in candidate_paths.windows(2) {
            if js_utf16_cmp(&pair[0], &pair[1]) != std::cmp::Ordering::Less {
                return Err(KernelError::UnsupportedLiteral(
                    "candidate paths are not strictly JS-ordered".into(),
                ));
            }
        }

        let finder = LiteralFinder::new(literal.as_bytes(), ignore_ascii_case);
        let mut matches = Vec::new();
        let mut total_matches = 0u64;
        let mut total_occurrences = 0u64;
        let mut indexed_occurrences = 0u64;
        for relative_path in candidate_paths {
            check_cancelled(cancelled)?;
            let record =
                self.find_file_by_path(relative_path)?
                    .ok_or(KernelError::UnsupportedLiteral(
                        "candidate is not in the indexed universe",
                    ))?;
            if record.flags & FLAG_BINARY != 0 {
                return Err(KernelError::UnsupportedLiteral(
                    "binary candidate requires ripgrep",
                ));
            }
            let content = self.content(record)?;
            let indexed_content = automatic_encoding(&content).is_none();
            let searchable_content = match automatic_encoding(&content) {
                Some(AutomaticEncoding::Utf8)
                    if std::str::from_utf8(&content[3..]).is_ok()
                        && memchr(0, &content[3..]).is_none() =>
                {
                    &content[3..]
                }
                Some(_) => {
                    return Err(KernelError::UnsupportedLiteral(
                        "transcoded candidate requires ripgrep",
                    ));
                }
                None => &content,
            };
            if memchr::memchr_iter(b'\r', searchable_content)
                .any(|offset| searchable_content.get(offset + 1) != Some(&b'\n'))
            {
                return Err(KernelError::UnsupportedLiteral(
                    "bare CR candidate requires ripgrep",
                ));
            }
            let lines = content_lines(searchable_content)?;
            let mut next_cancel_check = 64 * 1024;
            for (line_index, line) in lines.iter().copied().enumerate() {
                if line.start >= next_cancel_check {
                    next_cancel_check = line.start.saturating_add(64 * 1024);
                    check_cancelled(cancelled)?;
                }
                let haystack = &searchable_content[line.start..line.match_end];
                let mut ranges = Vec::new();
                let mut line_matched = false;
                let mut window_start = 0usize;
                let mut next_allowed = 0usize;
                while window_start < haystack.len() {
                    check_cancelled(cancelled)?;
                    let primary_end = window_start.saturating_add(64 * 1024).min(haystack.len());
                    let search_start = window_start.max(next_allowed);
                    let overlap = literal.len().saturating_sub(1);
                    let search_end = primary_end.saturating_add(overlap).min(haystack.len());
                    if search_start < search_end {
                        let mut finder_start = search_start;
                        while finder_start < search_end {
                            let Some(relative_offset) =
                                finder.find(&haystack[finder_start..search_end])
                            else {
                                break;
                            };
                            let offset = finder_start
                                .checked_add(relative_offset)
                                .ok_or(KernelError::TooLarge)?;
                            if offset >= primary_end {
                                break;
                            }
                            line_matched = true;
                            let end = offset
                                .checked_add(literal.len())
                                .ok_or(KernelError::TooLarge)?;
                            next_allowed = end;
                            finder_start = end;
                            total_occurrences = checked_add(total_occurrences, 1)?;
                            if indexed_content {
                                indexed_occurrences = checked_add(indexed_occurrences, 1)?;
                            }
                            if !match_limit.is_some_and(|limit| matches.len() >= limit) {
                                ranges.push(VerifiedRange {
                                    absolute_start: u64::try_from(line.start + offset)
                                        .map_err(|_| KernelError::TooLarge)?,
                                    absolute_end: u64::try_from(line.start + end)
                                        .map_err(|_| KernelError::TooLarge)?,
                                    line_start: u64::try_from(offset)
                                        .map_err(|_| KernelError::TooLarge)?,
                                    line_end: u64::try_from(end)
                                        .map_err(|_| KernelError::TooLarge)?,
                                });
                            }
                        }
                    }
                    window_start = primary_end;
                }
                if !line_matched {
                    continue;
                }
                total_matches = checked_add(total_matches, 1)?;
                if ranges.is_empty() {
                    continue;
                }
                let line_number = u64::try_from(line_index)
                    .map_err(|_| KernelError::TooLarge)?
                    .checked_add(1)
                    .ok_or(KernelError::TooLarge)?;
                let before_start = line_index.saturating_sub(before_count);
                let after_end = line_index
                    .checked_add(1)
                    .and_then(|value| value.checked_add(after_count))
                    .unwrap_or(lines.len())
                    .min(lines.len());
                matches.push(VerifiedMatch {
                    path: relative_path.to_owned(),
                    line_number,
                    line_text: decoded_line(searchable_content, line),
                    ranges,
                    before: lines[before_start..line_index]
                        .iter()
                        .map(|line| decoded_line(searchable_content, *line))
                        .collect(),
                    after: lines[line_index + 1..after_end]
                        .iter()
                        .map(|line| decoded_line(searchable_content, *line))
                        .collect(),
                });
            }
        }
        check_cancelled(cancelled)?;
        let verified_files =
            u64::try_from(candidate_paths.len()).map_err(|_| KernelError::TooLarge)?;
        Ok(LiteralVerifyResult {
            truncated: u64::try_from(matches.len()).map_err(|_| KernelError::TooLarge)?
                < total_matches,
            matches,
            total_matches,
            total_occurrences,
            indexed_occurrences,
            verified_files,
            query_duration: started.elapsed(),
        })
    }

    /// Plan a regex as one mandatory trigram posting and return file-level
    /// candidates only. The original regex must still be run by the product
    /// layer to produce exact matches, ranges, context and errors. Binary
    /// candidate paths contain only unresolved blockers whose persisted bytes
    /// before the first raw NUL still contain the selected mandatory trigram.
    ///
    /// `Ok(None)` means either the Rust-regex parser rejected the expression or
    /// structural induction could not prove one mandatory trigram. Both cases
    /// require full ripgrep fallback.
    ///
    /// # Errors
    ///
    /// Fails closed if a previously validated index record cannot be read.
    pub fn query_regex_candidates(
        &self,
        pattern: &str,
    ) -> Result<Option<RegexCandidateResult>, KernelError> {
        let started = Instant::now();
        let Ok(mandatory_grams) = regex_plan::mandatory_trigrams(pattern, false) else {
            return Ok(None);
        };
        let mandatory_gram_count =
            u64::try_from(mandatory_grams.len()).map_err(|_| KernelError::TooLarge)?;
        let indexed_mandatory_grams = mandatory_grams
            .into_iter()
            .filter(|gram| is_indexed_gram(*gram))
            .collect::<Vec<_>>();
        if indexed_mandatory_grams.is_empty() {
            return Ok(None);
        }

        let mut selected: Option<(u32, Option<GramRecord>, u64)> = None;
        for gram in indexed_mandatory_grams {
            let record = self.find_gram(gram)?;
            let postings_count = record.map_or(0, |value| value.postings_count);
            if selected.is_none_or(|(_, _, current)| postings_count < current) {
                selected = Some((gram, record, postings_count));
            }
            if postings_count == 0 {
                break;
            }
        }
        let Some((selected_gram, selected_record, candidate_files)) = selected else {
            return Ok(None);
        };

        let utf8_bom_candidate_paths =
            self.paths_for_file_ids(&self.transcoded_file_ids.utf8_bom)?;
        let transcoded_candidate_paths = self.safe_non_utf8_bom_paths()?;
        let unsafe_transcoded_paths =
            self.paths_for_file_ids(&self.transcoded_file_ids.decoded_nul)?;
        let packed_selected_gram = selected_gram.to_be_bytes();
        let selected_gram_bytes = [
            packed_selected_gram[1],
            packed_selected_gram[2],
            packed_selected_gram[3],
        ];
        let selected_gram_finder = memmem::Finder::new(&selected_gram_bytes);
        let mut candidate_paths = Vec::new();
        let mut binary_candidate_paths = Vec::new();
        if let Some(record) = selected_record {
            for file_id in self.posting_ids(record)? {
                if self.is_transcoded_file_id(file_id) {
                    continue;
                }
                let file = self.file_record(u64::from(file_id))?;
                let path = self.path(file)?.to_owned();
                if file.flags & FLAG_BINARY == 0 {
                    candidate_paths.push(path);
                } else if self.binary_prefix_contains_gram(file, &selected_gram_finder)? {
                    binary_candidate_paths.push(path);
                }
            }
        }

        Ok(Some(RegexCandidateResult {
            selected_gram,
            mandatory_grams: mandatory_gram_count,
            candidate_paths,
            candidate_files,
            binary_candidate_paths,
            utf8_bom_candidate_paths,
            transcoded_candidate_paths,
            unsafe_transcoded_paths,
            query_duration: started.elapsed(),
        }))
    }

    /// Verify a JS-ordered ordinary-text candidate list with ripgrep's Rust
    /// regex/searcher crates. Every candidate is scanned to keep total exact;
    /// a finite limit bounds only the matching lines materialized across N-API.
    ///
    /// # Errors
    ///
    /// Fails closed for invalid regexes, duplicate/out-of-order/non-indexed
    /// candidates, binary/unsupported-transcoded content, bare-CR lines,
    /// corruption, or cooperative cancellation. A valid UTF-8 BOM is stripped
    /// before search so line text and byte offsets match ripgrep's decoded view.
    pub fn verify_regex_candidates(
        &self,
        pattern: &str,
        candidate_paths: &[String],
        before_count: usize,
        after_count: usize,
        match_limit: Option<usize>,
        cancelled: &AtomicBool,
    ) -> Result<RegexVerifyResult, KernelError> {
        let started = Instant::now();
        let matcher = RegexMatcher::new_line_matcher(pattern)
            .map_err(|error| KernelError::UnsupportedRegex(error.to_string()))?;
        for pair in candidate_paths.windows(2) {
            if js_utf16_cmp(&pair[0], &pair[1]) != std::cmp::Ordering::Less {
                return Err(KernelError::UnsupportedRegex(
                    "candidate paths are not strictly JS-ordered".into(),
                ));
            }
        }

        let mut searcher = SearcherBuilder::new().line_number(true).build();
        let mut matches = Vec::new();
        let mut total_matches = 0u64;
        for relative_path in candidate_paths {
            check_cancelled(cancelled)?;
            let record = self.find_file_by_path(relative_path)?.ok_or_else(|| {
                KernelError::UnsupportedRegex(format!(
                    "candidate is not in the indexed universe: {relative_path}"
                ))
            })?;
            if record.flags & FLAG_BINARY != 0 {
                return Err(KernelError::UnsupportedRegex(format!(
                    "binary candidate requires ripgrep: {relative_path}"
                )));
            }
            let content = self.content(record)?;
            let searchable_content = match automatic_encoding(&content) {
                Some(AutomaticEncoding::Utf8)
                    if std::str::from_utf8(&content[3..]).is_ok()
                        && memchr(0, &content[3..]).is_none() =>
                {
                    &content[3..]
                }
                Some(_) => {
                    return Err(KernelError::UnsupportedRegex(format!(
                        "transcoded candidate requires ripgrep: {relative_path}"
                    )));
                }
                None => &content,
            };
            if memchr::memchr_iter(b'\r', searchable_content)
                .any(|offset| searchable_content.get(offset + 1) != Some(&b'\n'))
            {
                return Err(KernelError::UnsupportedRegex(format!(
                    "bare CR candidate requires ripgrep: {relative_path}"
                )));
            }
            let lines = content_lines(searchable_content)?;
            let materialize_limit = match_limit.map(|limit| limit.saturating_sub(matches.len()));
            let reader = CancelReader::new(searchable_content, cancelled);
            let mut sink = RegexVerifySink {
                matcher: &matcher,
                content: searchable_content,
                lines: &lines,
                relative_path,
                before_count,
                after_count,
                materialize_limit,
                cancelled,
                total_matches: 0,
                matches: Vec::new(),
            };
            if let Err(error) = searcher.search_reader(&matcher, reader, &mut sink) {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(KernelError::Aborted);
                }
                return Err(KernelError::UnsupportedRegex(format!(
                    "regex search failed for {relative_path}: {error}"
                )));
            }
            total_matches = checked_add(total_matches, sink.total_matches)?;
            matches.extend(sink.matches);
        }
        check_cancelled(cancelled)?;
        let verified_files =
            u64::try_from(candidate_paths.len()).map_err(|_| KernelError::TooLarge)?;
        Ok(RegexVerifyResult {
            truncated: u64::try_from(matches.len()).map_err(|_| KernelError::TooLarge)?
                < total_matches,
            matches,
            total_matches,
            verified_files,
            query_duration: started.elapsed(),
        })
    }

    fn find_file_by_path(&self, path: &str) -> Result<Option<FileRecord>, KernelError> {
        let mut left = 0u64;
        let mut right = self.header.file_count;
        while left < right {
            let middle = left + (right - left) / 2;
            let record = self.file_record(middle)?;
            match self.path(record)?.as_bytes().cmp(path.as_bytes()) {
                std::cmp::Ordering::Less => left = middle + 1,
                std::cmp::Ordering::Greater => right = middle,
                std::cmp::Ordering::Equal => return Ok(Some(record)),
            }
        }
        Ok(None)
    }

    fn binary_prefix_contains_gram(
        &self,
        record: FileRecord,
        finder: &memmem::Finder<'_>,
    ) -> Result<bool, KernelError> {
        if record.flags & FLAG_BINARY == 0 || record.first_nul == NO_NUL {
            return Err(KernelError::Corrupt(
                "binary candidate has no validated first NUL".into(),
            ));
        }
        let first_nul = usize::try_from(record.first_nul).map_err(|_| KernelError::TooLarge)?;
        let content = self.content(record)?;
        let prefix = content
            .get(..first_nul)
            .ok_or_else(|| KernelError::Corrupt("binary first NUL is out of bounds".into()))?;
        Ok(finder.find(prefix).is_some())
    }

    fn paths_for_file_ids(&self, file_ids: &[u32]) -> Result<Vec<String>, KernelError> {
        file_ids
            .iter()
            .map(|file_id| {
                let record = self.file_record(u64::from(*file_id))?;
                Ok(self.path(record)?.to_owned())
            })
            .collect()
    }

    fn safe_non_utf8_bom_paths(&self) -> Result<Vec<String>, KernelError> {
        self.transcoded_file_ids
            .safe
            .iter()
            .filter(|file_id| {
                self.transcoded_file_ids
                    .utf8_bom
                    .binary_search(file_id)
                    .is_err()
            })
            .map(|file_id| {
                let record = self.file_record(u64::from(*file_id))?;
                Ok(self.path(record)?.to_owned())
            })
            .collect()
    }

    fn is_transcoded_file_id(&self, file_id: u32) -> bool {
        self.transcoded_file_ids
            .safe
            .binary_search(&file_id)
            .is_ok()
            || self
                .transcoded_file_ids
                .decoded_nul
                .binary_search(&file_id)
                .is_ok()
    }

    fn find_gram(&self, key: u32) -> Result<Option<GramRecord>, KernelError> {
        let mut left = 0u64;
        let mut right = self.header.gram_count;
        while left < right {
            let middle = left + (right - left) / 2;
            let record = self.gram_record(middle)?;
            match record.key.cmp(&key) {
                std::cmp::Ordering::Less => left = middle + 1,
                std::cmp::Ordering::Greater => right = middle,
                std::cmp::Ordering::Equal => return Ok(Some(record)),
            }
        }
        Ok(None)
    }

    fn file_record(&self, index: u64) -> Result<FileRecord, KernelError> {
        if index >= self.header.file_count {
            return Err(KernelError::Corrupt(
                "file record index is out of bounds".into(),
            ));
        }
        let relative = checked_mul(index, FILE_RECORD_LEN as u64)?;
        let offset = checked_add(self.header.file_table_offset, relative)?;
        decode_file_record(
            slice_at(&self.mmap, offset, FILE_RECORD_LEN as u64)?,
            self.header.format_version,
        )
    }

    fn gram_record(&self, index: u64) -> Result<GramRecord, KernelError> {
        if index >= self.header.gram_count {
            return Err(KernelError::Corrupt(
                "gram record index is out of bounds".into(),
            ));
        }
        if self.header.format_version == FORMAT_VERSION_V5 {
            let index = usize::try_from(index).map_err(|_| KernelError::TooLarge)?;
            return self
                .variable_gram_records
                .as_ref()
                .and_then(|records| records.get(index))
                .copied()
                .ok_or_else(|| KernelError::Corrupt("variable gram record is missing".into()));
        }
        let record_len = gram_record_len(self.header.format_version)?;
        let relative = checked_mul(index, record_len)?;
        let offset = checked_add(self.header.gram_table_offset, relative)?;
        decode_gram_record_for_format(
            slice_at(&self.mmap, offset, record_len)?,
            self.header.format_version,
        )
    }

    fn posting_ids(&self, gram: GramRecord) -> Result<Vec<u32>, KernelError> {
        if matches!(
            self.header.format_version,
            FORMAT_VERSION_V3 | FORMAT_VERSION_V4 | FORMAT_VERSION_V5
        ) {
            return decode_compact_posting_list(&self.mmap, self.header, gram)
                .map(|(file_ids, _)| file_ids);
        }
        (0..gram.postings_count)
            .map(|index| {
                let absolute_posting = checked_add(gram.postings_offset, index)?;
                let byte_offset = checked_add(
                    self.header.postings_offset,
                    checked_mul(absolute_posting, 4)?,
                )?;
                read_u32(slice_at(&self.mmap, byte_offset, 4)?, 0)
            })
            .collect()
    }

    fn path(&self, record: FileRecord) -> Result<&str, KernelError> {
        let offset = checked_add(self.header.paths_offset, record.path_offset)?;
        let bytes = slice_at(&self.mmap, offset, u64::from(record.path_len))?;
        std::str::from_utf8(bytes)
            .map_err(|_| KernelError::Corrupt("file path is not valid UTF-8".into()))
    }

    fn content(&self, record: FileRecord) -> Result<Cow<'_, [u8]>, KernelError> {
        decode_content(&self.mmap, self.header, record)
    }
}

#[derive(Clone, Copy)]
struct ContentLine {
    start: usize,
    match_end: usize,
    text_end: usize,
}

fn content_lines(content: &[u8]) -> Result<Vec<ContentLine>, KernelError> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for end in memchr::memchr_iter(b'\n', content) {
        let text_end = if end > start && content[end - 1] == b'\r' {
            end - 1
        } else {
            end
        };
        lines.push(ContentLine {
            start,
            match_end: end,
            text_end,
        });
        start = end.checked_add(1).ok_or(KernelError::TooLarge)?;
    }
    if start < content.len() {
        let text_end = if content.last() == Some(&b'\r') {
            content.len() - 1
        } else {
            content.len()
        };
        lines.push(ContentLine {
            start,
            match_end: content.len(),
            text_end,
        });
    }
    Ok(lines)
}

fn decoded_line(content: &[u8], line: ContentLine) -> String {
    String::from_utf8_lossy(&content[line.start..line.text_end]).into_owned()
}

fn path_is_in_scope(path: &str, path_root: Option<&str>) -> bool {
    let Some(path_root) = path_root else {
        return true;
    };
    path == path_root
        || path
            .strip_prefix(path_root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn ascii_case_gram_variants(gram: [u8; 3]) -> Vec<[u8; 3]> {
    let mut variants = vec![gram];
    for index in 0..gram.len() {
        if !gram[index].is_ascii_alphabetic() {
            continue;
        }
        let existing = variants.len();
        for variant_index in 0..existing {
            let mut alternate = variants[variant_index];
            alternate[index] = alternate[index].to_ascii_uppercase();
            variants.push(alternate);
        }
    }
    variants.sort_unstable();
    variants.dedup();
    variants
}

enum LiteralFinder<'a> {
    Exact(memmem::Finder<'a>),
    AsciiFold(&'a [u8]),
}

impl<'a> LiteralFinder<'a> {
    fn new(needle: &'a [u8], ignore_ascii_case: bool) -> Self {
        if ignore_ascii_case {
            Self::AsciiFold(needle)
        } else {
            Self::Exact(memmem::Finder::new(needle))
        }
    }

    fn find(&self, haystack: &[u8]) -> Option<usize> {
        match self {
            Self::Exact(finder) => finder.find(haystack),
            Self::AsciiFold(needle) => find_ascii_case_insensitive(haystack, needle),
        }
    }
}

fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let lower = needle[0].to_ascii_lowercase();
    let upper = needle[0].to_ascii_uppercase();
    let mut cursor = 0usize;
    while cursor <= haystack.len().saturating_sub(needle.len()) {
        let relative = if lower == upper {
            memchr(lower, &haystack[cursor..])
        } else {
            memchr::memchr2(lower, upper, &haystack[cursor..])
        }?;
        let start = cursor.checked_add(relative)?;
        let end = start.checked_add(needle.len())?;
        if end > haystack.len() {
            return None;
        }
        if haystack[start..end].eq_ignore_ascii_case(needle) {
            return Some(start);
        }
        cursor = start.checked_add(1)?;
    }
    None
}

#[derive(Debug)]
enum LiteralGlobSegment<'a> {
    Recursive,
    Pattern(&'a [u8]),
}

#[derive(Debug)]
struct LiteralGlob<'a> {
    basename: bool,
    segments: Vec<LiteralGlobSegment<'a>>,
}

impl<'a> LiteralGlob<'a> {
    fn compile(pattern: &'a str) -> Result<Self, KernelError> {
        let bytes = pattern.as_bytes();
        if bytes.is_empty()
            || bytes.first() == Some(&b'/')
            || bytes.last() == Some(&b'/')
            || bytes.iter().any(|byte| {
                matches!(
                    byte,
                    b'!' | b'?' | b'[' | b']' | b'{' | b'}' | b'\\' | 0 | b'\r' | b'\n'
                )
            })
        {
            return Err(KernelError::UnsupportedLiteral(
                "glob syntax is outside the supported literal subset",
            ));
        }

        let basename = !bytes.contains(&b'/');
        let raw_segments = bytes.split(|byte| *byte == b'/').collect::<Vec<_>>();
        let mut segments = Vec::with_capacity(raw_segments.len());
        for (index, segment) in raw_segments.iter().enumerate() {
            if segment.is_empty() || *segment == b"." || *segment == b".." {
                return Err(KernelError::UnsupportedLiteral(
                    "glob contains an unsupported path segment",
                ));
            }
            if *segment == b"**" {
                if basename
                    || index + 1 == raw_segments.len()
                    || matches!(segments.last(), Some(LiteralGlobSegment::Recursive))
                {
                    return Err(KernelError::UnsupportedLiteral(
                        "glob recursive wildcard is outside the supported position",
                    ));
                }
                segments.push(LiteralGlobSegment::Recursive);
            } else {
                if segment.windows(2).any(|window| window == b"**") {
                    return Err(KernelError::UnsupportedLiteral(
                        "glob recursive wildcard must occupy a complete segment",
                    ));
                }
                segments.push(LiteralGlobSegment::Pattern(segment));
            }
        }
        Ok(Self { basename, segments })
    }

    fn matches(&self, path: &str) -> bool {
        if self.basename {
            let basename = path.rsplit('/').next().unwrap_or(path);
            let Some(LiteralGlobSegment::Pattern(pattern)) = self.segments.first() else {
                return false;
            };
            return glob_segment_matches(pattern, basename.as_bytes());
        }

        let path_segments = path
            .as_bytes()
            .split(|byte| *byte == b'/')
            .collect::<Vec<_>>();
        let mut previous = vec![false; path_segments.len() + 1];
        previous[0] = true;
        for segment in &self.segments {
            let mut current = vec![false; path_segments.len() + 1];
            match segment {
                LiteralGlobSegment::Recursive => {
                    current[0] = previous[0];
                    for index in 1..=path_segments.len() {
                        current[index] = previous[index] || current[index - 1];
                    }
                }
                LiteralGlobSegment::Pattern(pattern) => {
                    for index in 1..=path_segments.len() {
                        current[index] = previous[index - 1]
                            && glob_segment_matches(pattern, path_segments[index - 1]);
                    }
                }
            }
            previous = current;
        }
        previous[path_segments.len()]
    }
}

fn glob_segment_matches(pattern: &[u8], value: &[u8]) -> bool {
    let mut pattern_index = 0usize;
    let mut value_index = 0usize;
    let mut star_index = None;
    let mut star_value_index = 0usize;
    while value_index < value.len() {
        if pattern.get(pattern_index) == Some(&b'*') {
            star_index = Some(pattern_index);
            pattern_index += 1;
            star_value_index = value_index;
        } else if pattern.get(pattern_index) == value.get(value_index) {
            pattern_index += 1;
            value_index += 1;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            star_value_index += 1;
            value_index = star_value_index;
        } else {
            return false;
        }
    }
    pattern[pattern_index..].iter().all(|byte| *byte == b'*')
}

fn path_matches_filters(
    path: &str,
    path_root: Option<&str>,
    glob: Option<&LiteralGlob<'_>>,
) -> bool {
    path_is_in_scope(path, path_root) && glob.is_none_or(|matcher| matcher.matches(path))
}

fn js_utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), KernelError> {
    if cancelled.load(Ordering::Relaxed) {
        Err(KernelError::Aborted)
    } else {
        Ok(())
    }
}

struct CancelReader<'a> {
    content: &'a [u8],
    cursor: usize,
    cancelled: &'a AtomicBool,
}

impl<'a> CancelReader<'a> {
    fn new(content: &'a [u8], cancelled: &'a AtomicBool) -> Self {
        Self {
            content,
            cursor: 0,
            cancelled,
        }
    }
}

impl Read for CancelReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "kernel regex verification aborted",
            ));
        }
        let remaining = &self.content[self.cursor..];
        if remaining.is_empty() || output.is_empty() {
            return Ok(0);
        }
        let length = remaining.len().min(output.len()).min(64 * 1024);
        output[..length].copy_from_slice(&remaining[..length]);
        self.cursor = self
            .cursor
            .checked_add(length)
            .ok_or_else(|| io::Error::other("regex reader offset overflow"))?;
        Ok(length)
    }
}

struct RegexVerifySink<'a> {
    matcher: &'a RegexMatcher,
    content: &'a [u8],
    lines: &'a [ContentLine],
    relative_path: &'a str,
    before_count: usize,
    after_count: usize,
    materialize_limit: Option<usize>,
    cancelled: &'a AtomicBool,
    total_matches: u64,
    matches: Vec<VerifiedMatch>,
}

impl Sink for RegexVerifySink<'_> {
    type Error = io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        matched: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        self.total_matches = self
            .total_matches
            .checked_add(1)
            .ok_or_else(|| io::Error::other("matching line count overflow"))?;
        if self
            .materialize_limit
            .is_some_and(|limit| self.matches.len() >= limit)
        {
            return Ok(true);
        }
        let line_number = matched
            .line_number()
            .ok_or_else(|| io::Error::other("regex searcher omitted a line number"))?;
        let zero_based = line_number
            .checked_sub(1)
            .ok_or_else(|| io::Error::other("regex searcher returned line number zero"))?;
        let line_index = usize::try_from(zero_based)
            .map_err(|_| io::Error::other("line number does not fit usize"))?;
        let line = *self
            .lines
            .get(line_index)
            .ok_or_else(|| io::Error::other("regex line number is out of bounds"))?;
        let haystack = &self.content[line.start..line.match_end];
        let mut ranges = Vec::new();
        let mut next_cancel_check = 64 * 1024;
        let mut aborted = false;
        self.matcher
            .find_iter(haystack, |range| {
                if range.start() >= next_cancel_check {
                    next_cancel_check = range.start().saturating_add(64 * 1024);
                    if self.cancelled.load(Ordering::Relaxed) {
                        aborted = true;
                        return false;
                    }
                }
                ranges.push(VerifiedRange {
                    absolute_start: u64::try_from(line.start + range.start())
                        .expect("matched offset fits u64"),
                    absolute_end: u64::try_from(line.start + range.end())
                        .expect("matched offset fits u64"),
                    line_start: u64::try_from(range.start()).expect("matched offset fits u64"),
                    line_end: u64::try_from(range.end()).expect("matched offset fits u64"),
                });
                true
            })
            .map_err(|error| io::Error::other(error.to_string()))?;
        if aborted {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "kernel regex verification aborted",
            ));
        }
        if ranges.is_empty() {
            return Err(io::Error::other(
                "regex searcher reported a line without a reproducible submatch",
            ));
        }
        let before_start = line_index.saturating_sub(self.before_count);
        let after_end = line_index
            .checked_add(1)
            .and_then(|value| value.checked_add(self.after_count))
            .unwrap_or(self.lines.len())
            .min(self.lines.len());
        self.matches.push(VerifiedMatch {
            path: self.relative_path.to_owned(),
            line_number,
            line_text: decoded_line(self.content, line),
            ranges,
            before: self.lines[before_start..line_index]
                .iter()
                .map(|line| decoded_line(self.content, *line))
                .collect(),
            after: self.lines[line_index + 1..after_end]
                .iter()
                .map(|line| decoded_line(self.content, *line))
                .collect(),
        });
        Ok(true)
    }
}

/// Build an immutable index from an explicit, already-filtered file universe.
///
/// # Errors
///
/// Returns a typed error for unsafe paths, source files that change during the
/// two-pass build, arithmetic overflow, and any filesystem/write failure.
pub fn build_index(
    root: impl AsRef<Path>,
    relative_paths: &[String],
    index_path: impl AsRef<Path>,
) -> Result<BuildStats, KernelError> {
    build_index_impl::<false>(root.as_ref(), relative_paths, index_path.as_ref())
        .map(|outcome| outcome.stats)
}

pub(crate) fn build_index_with_source_digest(
    root: impl AsRef<Path>,
    relative_paths: &[String],
    index_path: impl AsRef<Path>,
) -> Result<BuildWithSourceDigest, KernelError> {
    let outcome = build_index_impl::<true>(root.as_ref(), relative_paths, index_path.as_ref())?;
    Ok(BuildWithSourceDigest {
        stats: outcome.stats,
        content_sha256: outcome
            .content_sha256
            .expect("source digest requested from build implementation"),
        source_bytes: outcome.source_bytes,
    })
}

fn write_index_tables(
    writer: &mut impl Write,
    sources: &[SourceFile],
    grams: &[(u32, Vec<u32>)],
    compact_postings: Option<&CompactPostingData>,
    format_version: u32,
    temporary_path: &Path,
) -> Result<(), KernelError> {
    for source in sources {
        let path_len =
            u32::try_from(source.relative_path.len()).map_err(|_| KernelError::TooLarge)?;
        let record = FileRecord {
            path_offset: source.path_offset,
            path_len,
            flags: (if source.first_nul.is_some() {
                FLAG_BINARY
            } else {
                0
            }) | if source.compressed {
                FLAG_COMPRESSED
            } else {
                0
            },
            content_offset: source.content_offset,
            content_len: source.content_len,
            first_nul: source.first_nul.unwrap_or(NO_NUL),
            stored_len: source.stored_len,
        };
        writer
            .write_all(&encode_file_record(record, format_version))
            .map_err(|source| io_error("writing file table", temporary_path, source))?;
    }

    if let Some(compact) = compact_postings {
        if compact.records.len() != grams.len() {
            return Err(KernelError::Corrupt(
                "compact gram records do not match the gram vocabulary".into(),
            ));
        }
        if format_version == FORMAT_VERSION_V5 {
            writer.write_all(&compact.gram_bytes).map_err(|source| {
                io_error("writing variable gram table", temporary_path, source)
            })?;
        } else {
            for record in &compact.records {
                writer
                    .write_all(&encode_compact_gram_record(*record)?)
                    .map_err(|source| {
                        io_error("writing compact gram table", temporary_path, source)
                    })?;
            }
        }
        writer
            .write_all(&compact.bytes)
            .map_err(|source| io_error("writing compact postings", temporary_path, source))?;
    } else {
        let mut posting_cursor = 0u64;
        for (key, values) in grams {
            let record = GramRecord {
                key: *key,
                postings_offset: posting_cursor,
                postings_count: u64::try_from(values.len()).map_err(|_| KernelError::TooLarge)?,
            };
            writer
                .write_all(&encode_gram_record(record))
                .map_err(|source| io_error("writing gram table", temporary_path, source))?;
            posting_cursor = checked_add(posting_cursor, record.postings_count)?;
        }
        for (_, values) in grams {
            for value in values {
                writer
                    .write_all(&value.to_le_bytes())
                    .map_err(|source| io_error("writing postings", temporary_path, source))?;
            }
        }
    }
    for source in sources {
        writer
            .write_all(source.relative_path.as_bytes())
            .map_err(|error| io_error("writing path blob", temporary_path, error))?;
    }
    Ok(())
}

fn encode_compact_postings(grams: &[(u32, Vec<u32>)]) -> Result<CompactPostingData, KernelError> {
    let mut records = Vec::with_capacity(grams.len());
    let mut gram_bytes = Vec::new();
    let mut bytes = Vec::new();
    let mut previous_key = None;
    for (key, file_ids) in grams {
        let postings_offset = u64::try_from(bytes.len()).map_err(|_| KernelError::TooLarge)?;
        let mut previous = None;
        for file_id in file_ids {
            let delta = match previous {
                None => u64::from(*file_id) + 1,
                Some(value) if value < *file_id => u64::from(*file_id - value),
                Some(_) => {
                    return Err(KernelError::Corrupt(
                        "builder produced unsorted duplicate postings".into(),
                    ));
                }
            };
            encode_varint(delta, &mut bytes);
            previous = Some(*file_id);
        }
        let postings_count = u64::try_from(file_ids.len()).map_err(|_| KernelError::TooLarge)?;
        let key_delta = match previous_key {
            None => u64::from(*key) + 1,
            Some(previous) if previous < *key => u64::from(*key - previous),
            Some(_) => {
                return Err(KernelError::Corrupt(
                    "builder produced unsorted duplicate gram keys".into(),
                ));
            }
        };
        encode_varint(key_delta, &mut gram_bytes);
        encode_varint(postings_count, &mut gram_bytes);
        records.push(GramRecord {
            key: *key,
            postings_offset,
            postings_count,
        });
        previous_key = Some(*key);
    }
    Ok(CompactPostingData {
        records,
        gram_bytes,
        bytes,
    })
}

#[allow(clippy::too_many_lines)]
fn build_index_impl<const INCLUDE_SOURCE_DIGEST: bool>(
    root: &Path,
    relative_paths: &[String],
    index_path: &Path,
) -> Result<BuildOutcome, KernelError> {
    build_index_impl_with_trusted_acquisition::<INCLUDE_SOURCE_DIGEST>(
        root,
        relative_paths,
        index_path,
        true,
    )
}

#[allow(clippy::too_many_lines)]
fn build_index_impl_with_trusted_acquisition<const INCLUDE_SOURCE_DIGEST: bool>(
    root: &Path,
    relative_paths: &[String],
    index_path: &Path,
    enable_trusted_acquisition: bool,
) -> Result<BuildOutcome, KernelError> {
    let started = Instant::now();
    let canonical_root = fs::canonicalize(root)
        .map_err(|source| io_error("canonicalizing repository root", root, source))?;
    let parent = index_path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|source| io_error("creating index directory", parent, source))?;

    let mut sorted_paths = relative_paths.to_vec();
    sorted_paths.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    for pair in sorted_paths.windows(2) {
        if pair[0] == pair[1] {
            return Err(KernelError::InvalidRelativePath {
                path: pair[0].clone(),
                reason: "duplicate path",
            });
        }
    }
    let file_count = u64::try_from(sorted_paths.len()).map_err(|_| KernelError::TooLarge)?;
    if file_count > u64::from(u32::MAX) {
        return Err(KernelError::TooLarge);
    }
    let needs_source_reorder = INCLUDE_SOURCE_DIGEST
        && relative_paths
            .iter()
            .zip(&sorted_paths)
            .any(|(caller, sorted)| caller != sorted);
    let traversal_paths = if INCLUDE_SOURCE_DIGEST {
        relative_paths.to_vec()
    } else {
        std::mem::take(&mut sorted_paths)
    };

    let resolved_index = absolute_lexical(index_path)?;
    let mut sources = Vec::with_capacity(traversal_paths.len());
    let mut postings: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut path_cursor = 0u64;
    let mut content_cursor = 0u64;
    let mut source_bytes = 0u64;
    let mut binary_files = 0u64;
    let mut source_hasher = INCLUDE_SOURCE_DIGEST.then(Sha256::new);
    let use_content_first_v5 = INCLUDE_SOURCE_DIGEST && !needs_source_reorder;
    let trusted_build_root = if use_content_first_v5 && enable_trusted_acquisition {
        TrustedBuildRoot::prepare(root, &canonical_root, index_path, parent)?
    } else {
        None
    };
    let mut streamed_payload = if use_content_first_v5 {
        let mut temporary = NamedTempFile::new_in(parent)
            .map_err(|source| io_error("creating temporary index", parent, source))?;
        temporary
            .as_file_mut()
            .write_all(&[0u8; HEADER_LEN])
            .map_err(|source| {
                io_error("writing index header placeholder", temporary.path(), source)
            })?;
        let temporary_path = temporary.path().to_path_buf();
        let mut payload_file = temporary
            .reopen()
            .map_err(|source| io_error("reopening temporary index", &temporary_path, source))?;
        payload_file
            .seek(SeekFrom::Start(HEADER_LEN as u64))
            .map_err(|source| {
                io_error("seeking to content-first payload", &temporary_path, source)
            })?;
        Some((temporary, HashingWriter::new(payload_file), temporary_path))
    } else {
        None
    };

    for (traversal_index, relative_path) in traversal_paths.into_iter().enumerate() {
        let file_id = if needs_source_reorder {
            sorted_paths
                .binary_search_by(|sorted| sorted.as_bytes().cmp(relative_path.as_bytes()))
                .map_err(|_| {
                    KernelError::Corrupt(
                        "caller path is missing from the sorted source universe".into(),
                    )
                })?
        } else {
            traversal_index
        };
        validate_relative_path(&relative_path)?;
        let joined = canonical_root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let (canonical_file, before, content) = if let Some(trusted) = trusted_build_root.as_ref() {
            trusted.read_source(&relative_path, &joined)?
        } else {
            read_source_legacy(&canonical_root, &joined, &resolved_index, &relative_path)?
        };
        if let Some(hasher) = source_hasher.as_mut() {
            update_sha256_length_prefix(
                hasher,
                u64::try_from(relative_path.len()).map_err(|_| KernelError::TooLarge)?,
            );
            hasher.update(relative_path.as_bytes());
            update_sha256_length_prefix(hasher, before.len);
            hasher.update(&content);
        }

        let first_nul = memchr(0, &content)
            .map(|offset| u64::try_from(offset).map_err(|_| KernelError::TooLarge))
            .transpose()?;
        let content_checksum = *blake3::hash(&content).as_bytes();
        if first_nul.is_some() {
            binary_files = checked_add(binary_files, 1)?;
        }

        let mut file_grams = content
            .windows(3)
            .map(pack_gram)
            .filter(|gram| is_indexed_gram(*gram))
            .collect::<Vec<_>>();
        file_grams.sort_unstable();
        file_grams.dedup();
        let id = u32::try_from(file_id).map_err(|_| KernelError::TooLarge)?;
        for gram in file_grams {
            postings.entry(gram).or_default().push(id);
        }
        let content_len = before.len;
        source_bytes = checked_add(source_bytes, content_len)?;
        let mut stored_len = content_len;
        let mut compressed = false;
        if let Some((_, writer, temporary_path)) = streamed_payload.as_mut() {
            let compressed_content = lz4_flex::block::compress(&content);
            let stored_content = if compressed_content.len() < content.len() {
                compressed = true;
                compressed_content.as_slice()
            } else {
                content.as_slice()
            };
            stored_len = u64::try_from(stored_content.len()).map_err(|_| KernelError::TooLarge)?;
            writer.write_all(stored_content).map_err(|source| {
                io_error("writing content-first payload", temporary_path, source)
            })?;
        }

        let path_len = u64::try_from(relative_path.len()).map_err(|_| KernelError::TooLarge)?;
        sources.push(SourceFile {
            relative_path,
            absolute_path: canonical_file,
            path_offset: if needs_source_reorder { 0 } else { path_cursor },
            content_offset: if needs_source_reorder {
                0
            } else {
                content_cursor
            },
            content_len,
            stored_len,
            compressed,
            content_checksum,
            first_nul,
            snapshot: before,
        });
        if !needs_source_reorder {
            path_cursor = checked_add(path_cursor, path_len)?;
            content_cursor = checked_add(content_cursor, stored_len)?;
        }
    }
    if needs_source_reorder {
        sources.sort_unstable_by(|left, right| {
            left.relative_path
                .as_bytes()
                .cmp(right.relative_path.as_bytes())
        });
        for values in postings.values_mut() {
            values.sort_unstable();
        }
        for source in &mut sources {
            source.path_offset = path_cursor;
            source.content_offset = content_cursor;
            path_cursor = checked_add(
                path_cursor,
                u64::try_from(source.relative_path.len()).map_err(|_| KernelError::TooLarge)?,
            )?;
            content_cursor = checked_add(content_cursor, source.stored_len)?;
        }
    }

    let mut grams = postings.into_iter().collect::<Vec<_>>();
    grams.sort_unstable_by_key(|(key, _)| *key);
    let gram_count = u64::try_from(grams.len()).map_err(|_| KernelError::TooLarge)?;
    let posting_count = grams.iter().try_fold(0u64, |total, (_, values)| {
        checked_add(
            total,
            u64::try_from(values.len()).map_err(|_| KernelError::TooLarge)?,
        )
    })?;

    let compact_postings = use_content_first_v5
        .then(|| encode_compact_postings(&grams))
        .transpose()?;
    let file_table_len = checked_mul(file_count, FILE_RECORD_LEN as u64)?;
    let gram_table_len = if let Some(compact) = compact_postings.as_ref() {
        u64::try_from(compact.gram_bytes.len()).map_err(|_| KernelError::TooLarge)?
    } else {
        checked_mul(gram_count, GRAM_RECORD_LEN as u64)?
    };
    let postings_len = if let Some(compact) = compact_postings.as_ref() {
        u64::try_from(compact.bytes.len()).map_err(|_| KernelError::TooLarge)?
    } else {
        checked_mul(posting_count, 4)?
    };
    let format_version = if use_content_first_v5 {
        FORMAT_VERSION_V5
    } else {
        FORMAT_VERSION_V1
    };
    let (
        file_table_offset,
        gram_table_offset,
        postings_offset,
        paths_offset,
        contents_offset,
        total_len,
    ) = if use_content_first_v5 {
        let contents_offset = HEADER_LEN as u64;
        let file_table_offset = checked_add(contents_offset, content_cursor)?;
        let gram_table_offset = checked_add(file_table_offset, file_table_len)?;
        let postings_offset = checked_add(gram_table_offset, gram_table_len)?;
        let paths_offset = checked_add(postings_offset, postings_len)?;
        let total_len = checked_add(paths_offset, path_cursor)?;
        (
            file_table_offset,
            gram_table_offset,
            postings_offset,
            paths_offset,
            contents_offset,
            total_len,
        )
    } else {
        let file_table_offset = HEADER_LEN as u64;
        let gram_table_offset = checked_add(file_table_offset, file_table_len)?;
        let postings_offset = checked_add(gram_table_offset, gram_table_len)?;
        let paths_offset = checked_add(postings_offset, postings_len)?;
        let contents_offset = checked_add(paths_offset, path_cursor)?;
        let total_len = checked_add(contents_offset, content_cursor)?;
        (
            file_table_offset,
            gram_table_offset,
            postings_offset,
            paths_offset,
            contents_offset,
            total_len,
        )
    };

    let (mut temporary, payload_checksum) =
        if let Some((temporary, mut writer, temporary_path)) = streamed_payload.take() {
            if trusted_build_root.is_none() {
                for source in &sources {
                    if source_snapshot(&source.absolute_path)? != source.snapshot {
                        return Err(KernelError::SourceChanged(source.relative_path.clone()));
                    }
                }
            }
            write_index_tables(
                &mut writer,
                &sources,
                &grams,
                compact_postings.as_ref(),
                format_version,
                &temporary_path,
            )?;
            let payload_checksum = writer
                .finish()
                .map_err(|source| io_error("flushing index payload", &temporary_path, source))?;
            // The isolated Pi-start contract excludes unmarked writers while
            // this synchronous N-API call owns the generation. Each source was
            // read through one beneath-root descriptor with pre/post handle
            // identity; the final O(1) root fence replaces public-builder
            // current-path sweeps without weakening the v1 path.
            if let Some(trusted) = trusted_build_root.as_ref() {
                trusted.verify()?;
            }
            (temporary, payload_checksum)
        } else {
            let mut temporary = NamedTempFile::new_in(parent)
                .map_err(|source| io_error("creating temporary index", parent, source))?;
            temporary
                .as_file_mut()
                .write_all(&[0u8; HEADER_LEN])
                .map_err(|source| {
                    io_error("writing index header placeholder", temporary.path(), source)
                })?;
            let temporary_path = temporary.path().to_path_buf();
            let payload_checksum = {
                let mut writer = HashingWriter::new(temporary.as_file_mut());
                write_index_tables(
                    &mut writer,
                    &sources,
                    &grams,
                    compact_postings.as_ref(),
                    format_version,
                    &temporary_path,
                )?;
                for source in &sources {
                    if source_snapshot(&source.absolute_path)? != source.snapshot {
                        return Err(KernelError::SourceChanged(source.relative_path.clone()));
                    }
                    let mut file = File::open(&source.absolute_path).map_err(|error| {
                        io_error("reopening source file", &source.absolute_path, error)
                    })?;
                    let (copied, copied_checksum) =
                        copy_and_hash(&mut file, &mut writer).map_err(|error| {
                            io_error("copying source content into index", &temporary_path, error)
                        })?;
                    if copied != source.content_len
                        || copied_checksum != source.content_checksum
                        || source_snapshot(&source.absolute_path)? != source.snapshot
                    {
                        return Err(KernelError::SourceChanged(source.relative_path.clone()));
                    }
                }
                writer
                    .finish()
                    .map_err(|source| io_error("flushing index payload", &temporary_path, source))?
            };
            (temporary, payload_checksum)
        };

    let header = Header {
        format_version,
        file_count,
        gram_count,
        posting_count,
        binary_file_count: binary_files,
        file_table_offset,
        file_table_len,
        gram_table_offset,
        gram_table_len,
        postings_offset,
        postings_len,
        paths_offset,
        paths_len: path_cursor,
        contents_offset,
        contents_len: content_cursor,
        total_len,
        payload_checksum,
    };
    temporary
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|source| io_error("seeking temporary index", temporary.path(), source))?;
    temporary
        .as_file_mut()
        .write_all(&encode_header(header))
        .map_err(|source| io_error("writing final index header", temporary.path(), source))?;
    temporary
        .as_file_mut()
        .set_len(total_len)
        .map_err(|source| io_error("setting index length", temporary.path(), source))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|source| io_error("syncing temporary index", temporary.path(), source))?;
    temporary
        .persist(index_path)
        .map_err(|error| io_error("atomically replacing index", index_path, error.error))?;
    sync_parent(parent)?;

    Ok(BuildOutcome {
        stats: BuildStats {
            format_version,
            files: file_count,
            binary_files,
            grams: gram_count,
            postings: posting_count,
            index_bytes: total_len,
            build_duration: started.elapsed(),
        },
        content_sha256: source_hasher.map(|hasher| format!("{:x}", hasher.finalize())),
        source_bytes,
    })
}

fn validate_literal(literal: &str) -> Result<(), KernelError> {
    let bytes = literal.as_bytes();
    if bytes.len() < 3 {
        return Err(KernelError::UnsupportedLiteral(
            "literal is shorter than three UTF-8 bytes",
        ));
    }
    if bytes.iter().any(|byte| matches!(*byte, 0 | b'\r' | b'\n')) {
        return Err(KernelError::UnsupportedLiteral(
            "literal contains NUL or a line break",
        ));
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), KernelError> {
    if path.is_empty() {
        return Err(invalid_path(path, "path is empty"));
    }
    if path
        .as_bytes()
        .iter()
        .any(|byte| matches!(*byte, 0 | b'\r' | b'\n'))
    {
        return Err(invalid_path(path, "path contains NUL or a line break"));
    }
    if path.starts_with('/') || path.contains('\\') {
        return Err(invalid_path(path, "path is not a relative POSIX path"));
    }
    let segments = path.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."))
    {
        return Err(invalid_path(
            path,
            "path contains an empty, dot, or dot-dot segment",
        ));
    }
    for (index, segment) in segments.iter().enumerate() {
        if *segment == ".git" || *segment == ".fast-grep" {
            return Err(invalid_path(
                path,
                "path is inside an implementation directory",
            ));
        }
        if *segment == ".pi" && segments.get(index + 1).is_some_and(|next| *next == "index") {
            return Err(invalid_path(path, "path is inside .pi/index"));
        }
    }
    Ok(())
}

fn invalid_path(path: &str, reason: &'static str) -> KernelError {
    KernelError::InvalidRelativePath {
        path: path.to_owned(),
        reason,
    }
}

impl TrustedBuildRoot {
    fn prepare(
        original_root: &Path,
        canonical_root: &Path,
        index_path: &Path,
        index_parent: &Path,
    ) -> Result<Option<Self>, KernelError> {
        let Some(index_leaf) = index_path.file_name() else {
            return Ok(None);
        };
        let canonical_index_parent = fs::canonicalize(index_parent).map_err(|source| {
            io_error(
                "canonicalizing index parent directory",
                index_parent,
                source,
            )
        })?;
        let root_metadata = fs::metadata(canonical_root).map_err(|source| {
            io_error("reading repository root metadata", canonical_root, source)
        })?;
        let root_file_id = stable_file_id(&root_metadata);
        let Some(root) = prepare_beneath_root(canonical_root, root_file_id)? else {
            return Ok(None);
        };
        Ok(Some(Self {
            root,
            original_root: original_root.to_path_buf(),
            canonical_root: canonical_root.to_path_buf(),
            root_file_id,
            resolved_index: canonical_index_parent.join(index_leaf),
            index_leaf: index_leaf.to_os_string(),
        }))
    }

    fn read_source(
        &self,
        relative_path: &str,
        joined: &Path,
    ) -> Result<(PathBuf, SourceSnapshot, Vec<u8>), KernelError> {
        let (mut file, canonical_file) =
            match open_build_source_beneath(&self.root, Path::new(relative_path)) {
                Ok(file) => {
                    let canonical_file = if joined == self.resolved_index
                        || joined.file_name() == Some(self.index_leaf.as_os_str())
                    {
                        let canonical_file = fs::canonicalize(joined).map_err(|source| {
                            io_error("canonicalizing source file", joined, source)
                        })?;
                        if !canonical_file.starts_with(&self.canonical_root) {
                            return Err(KernelError::InvalidRelativePath {
                                path: relative_path.to_owned(),
                                reason: "canonical path escapes the repository root",
                            });
                        }
                        if canonical_file == self.resolved_index {
                            return Err(KernelError::InvalidRelativePath {
                                path: relative_path.to_owned(),
                                reason: "index output cannot be part of its own input",
                            });
                        }
                        canonical_file
                    } else {
                        joined.to_path_buf()
                    };
                    (file, canonical_file)
                }
                Err(source) if is_beneath_escape_rejection(&source) => {
                    let path_metadata = fs::symlink_metadata(joined)
                        .map_err(|error| io_error("reading source metadata", joined, error))?;
                    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
                        return Err(KernelError::InvalidRelativePath {
                            path: relative_path.to_owned(),
                            reason: "path is not a regular non-symlink file",
                        });
                    }
                    let canonical_file = fs::canonicalize(joined)
                        .map_err(|error| io_error("canonicalizing source file", joined, error))?;
                    let canonical_relative = canonical_file
                        .strip_prefix(&self.canonical_root)
                        .map_err(|_| KernelError::InvalidRelativePath {
                            path: relative_path.to_owned(),
                            reason: "canonical path escapes the repository root",
                        })?;
                    if canonical_file == self.resolved_index {
                        return Err(KernelError::InvalidRelativePath {
                            path: relative_path.to_owned(),
                            reason: "index output cannot be part of its own input",
                        });
                    }
                    let file = open_build_source_beneath(&self.root, canonical_relative)
                        .map_err(|error| beneath_open_error(relative_path, joined, error))?;
                    (file, canonical_file)
                }
                Err(source) => {
                    return Err(beneath_open_error(relative_path, joined, source));
                }
            };

        let before_metadata = file
            .metadata()
            .map_err(|source| io_error("reading source metadata", &canonical_file, source))?;
        if !before_metadata.is_file() {
            return Err(KernelError::InvalidRelativePath {
                path: relative_path.to_owned(),
                reason: "path is not a regular non-symlink file",
            });
        }
        let before_identity = stable_source_identity(&before_metadata);
        let before = snapshot_from_metadata(&before_metadata);
        let mut content = Vec::new();
        file.read_to_end(&mut content)
            .map_err(|source| io_error("reading source file", &canonical_file, source))?;
        let after_metadata = file
            .metadata()
            .map_err(|source| io_error("reading source metadata", &canonical_file, source))?;
        if before_identity != stable_source_identity(&after_metadata)
            || before.len != u64::try_from(content.len()).map_err(|_| KernelError::TooLarge)?
        {
            return Err(KernelError::SourceChanged(relative_path.to_owned()));
        }
        Ok((canonical_file, before, content))
    }

    fn verify(&self) -> Result<(), KernelError> {
        let final_canonical_root = fs::canonicalize(&self.original_root).map_err(|source| {
            io_error(
                "canonicalizing repository root",
                &self.original_root,
                source,
            )
        })?;
        let final_root_metadata = fs::metadata(&final_canonical_root).map_err(|source| {
            io_error(
                "reading repository root metadata",
                &final_canonical_root,
                source,
            )
        })?;
        let handle_metadata = self.root.metadata().map_err(|source| {
            io_error(
                "reading repository root handle metadata",
                &self.canonical_root,
                source,
            )
        })?;
        if final_canonical_root != self.canonical_root
            || !final_root_metadata.is_dir()
            || !handle_metadata.is_dir()
            || stable_file_id(&final_root_metadata) != self.root_file_id
            || stable_file_id(&handle_metadata) != self.root_file_id
        {
            return Err(KernelError::SourceChanged(
                "repository root changed during trusted index build".into(),
            ));
        }
        Ok(())
    }
}

fn read_source_legacy(
    canonical_root: &Path,
    joined: &Path,
    resolved_index: &Path,
    relative_path: &str,
) -> Result<(PathBuf, SourceSnapshot, Vec<u8>), KernelError> {
    let symlink_metadata = fs::symlink_metadata(joined)
        .map_err(|source| io_error("reading source metadata", joined, source))?;
    if symlink_metadata.file_type().is_symlink() || !symlink_metadata.is_file() {
        return Err(KernelError::InvalidRelativePath {
            path: relative_path.to_owned(),
            reason: "path is not a regular non-symlink file",
        });
    }
    let canonical_file = fs::canonicalize(joined)
        .map_err(|source| io_error("canonicalizing source file", joined, source))?;
    if !canonical_file.starts_with(canonical_root) {
        return Err(KernelError::InvalidRelativePath {
            path: relative_path.to_owned(),
            reason: "canonical path escapes the repository root",
        });
    }
    if absolute_lexical(&canonical_file)? == resolved_index {
        return Err(KernelError::InvalidRelativePath {
            path: relative_path.to_owned(),
            reason: "index output cannot be part of its own input",
        });
    }
    let before = source_snapshot(&canonical_file)?;
    let mut content = Vec::new();
    File::open(&canonical_file)
        .map_err(|source| io_error("opening source file", &canonical_file, source))?
        .read_to_end(&mut content)
        .map_err(|source| io_error("reading source file", &canonical_file, source))?;
    let after = source_snapshot(&canonical_file)?;
    if before != after
        || before.len != u64::try_from(content.len()).map_err(|_| KernelError::TooLarge)?
    {
        return Err(KernelError::SourceChanged(relative_path.to_owned()));
    }
    Ok((canonical_file, before, content))
}

fn source_snapshot(path: &Path) -> Result<SourceSnapshot, KernelError> {
    let metadata =
        fs::metadata(path).map_err(|source| io_error("reading source metadata", path, source))?;
    if !metadata.is_file() {
        return Err(KernelError::InvalidRelativePath {
            path: path.display().to_string(),
            reason: "source is no longer a regular file",
        });
    }
    Ok(snapshot_from_metadata(&metadata))
}

fn open_source_no_follow(path: &Path) -> Result<File, KernelError> {
    #[cfg(unix)]
    let opened = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path);
    #[cfg(not(unix))]
    let opened = File::open(path);
    opened.map_err(|source| io_error("opening source file", path, source))
}

fn prepare_beneath_root(
    canonical_root: &Path,
    expected_file_id: StableFileId,
) -> Result<Option<File>, KernelError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(canonical_root)
            .map_err(|source| {
                io_error("opening repository root directory", canonical_root, source)
            })?;
        let metadata = root.metadata().map_err(|source| {
            io_error("reading repository root metadata", canonical_root, source)
        })?;
        if !metadata.is_dir() || stable_file_id(&metadata) != expected_file_id {
            return Err(KernelError::SourceChanged(
                "repository root changed before constrained source open".into(),
            ));
        }
        // Probe both sides of the capability: "." must open, while ".." must
        // be rejected with the platform's containment errno. This refuses a
        // kernel that silently ignores an unknown flag.
        let inside = open_source_beneath(&root, ".");
        let escape = open_source_beneath(&root, "..");
        match (inside, escape) {
            (Ok(probe), Err(source))
                if probe.metadata().is_ok_and(|value| value.is_dir())
                    && is_beneath_escape_rejection(&source) =>
            {
                Ok(Some(root))
            }
            _ => Ok(None),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (canonical_root, expected_file_id);
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn is_beneath_escape_rejection(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ENOTCAPABLE)
}

#[cfg(target_os = "linux")]
fn is_beneath_escape_rejection(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EXDEV)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn is_beneath_escape_rejection(_error: &io::Error) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn open_source_beneath(root: &File, relative_path: &str) -> io::Result<File> {
    const O_RESOLVE_BENEATH: u32 = 0x0000_1000;
    let flags = rustix::fs::OFlags::RDONLY
        | rustix::fs::OFlags::CLOEXEC
        | rustix::fs::OFlags::NOFOLLOW
        | rustix::fs::OFlags::from_bits_retain(O_RESOLVE_BENEATH);
    rustix::io::retry_on_intr(|| {
        rustix::fs::openat(root, relative_path, flags, rustix::fs::Mode::empty())
    })
    .map(File::from)
    .map_err(io::Error::from)
}

#[cfg(target_os = "macos")]
fn open_build_source_beneath(root: &File, relative_path: &Path) -> io::Result<File> {
    const O_RESOLVE_BENEATH: u32 = 0x0000_1000;
    let flags = rustix::fs::OFlags::RDONLY
        | rustix::fs::OFlags::CLOEXEC
        | rustix::fs::OFlags::NOFOLLOW
        | rustix::fs::OFlags::NONBLOCK
        | rustix::fs::OFlags::from_bits_retain(O_RESOLVE_BENEATH);
    rustix::io::retry_on_intr(|| {
        rustix::fs::openat(root, relative_path, flags, rustix::fs::Mode::empty())
    })
    .map(File::from)
    .map_err(io::Error::from)
}

#[cfg(target_os = "linux")]
fn open_source_beneath(root: &File, relative_path: &str) -> io::Result<File> {
    let flags =
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::CLOEXEC | rustix::fs::OFlags::NOFOLLOW;
    let resolve = rustix::fs::ResolveFlags::BENEATH | rustix::fs::ResolveFlags::NO_MAGICLINKS;
    rustix::io::retry_on_intr(|| {
        rustix::fs::openat2(
            root,
            relative_path,
            flags,
            rustix::fs::Mode::empty(),
            resolve,
        )
    })
    .map(File::from)
    .map_err(io::Error::from)
}

#[cfg(target_os = "linux")]
fn open_build_source_beneath(root: &File, relative_path: &Path) -> io::Result<File> {
    let flags = rustix::fs::OFlags::RDONLY
        | rustix::fs::OFlags::CLOEXEC
        | rustix::fs::OFlags::NOFOLLOW
        | rustix::fs::OFlags::NONBLOCK;
    let resolve = rustix::fs::ResolveFlags::BENEATH | rustix::fs::ResolveFlags::NO_MAGICLINKS;
    rustix::io::retry_on_intr(|| {
        rustix::fs::openat2(
            root,
            relative_path,
            flags,
            rustix::fs::Mode::empty(),
            resolve,
        )
    })
    .map(File::from)
    .map_err(io::Error::from)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn open_source_beneath(_root: &File, _relative_path: &str) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "beneath-root open is unavailable",
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn open_build_source_beneath(_root: &File, _relative_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "beneath-root open is unavailable",
    ))
}

fn beneath_open_error(relative_path: &str, display_path: &Path, source: io::Error) -> KernelError {
    #[cfg(target_os = "macos")]
    let rejected = matches!(source.raw_os_error(), Some(libc::ENOTCAPABLE | libc::ELOOP));
    #[cfg(target_os = "linux")]
    let rejected = matches!(source.raw_os_error(), Some(libc::EXDEV | libc::ELOOP));
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let rejected = false;
    if rejected {
        return KernelError::InvalidRelativePath {
            path: relative_path.to_owned(),
            reason: "path resolution escapes the repository root or ends in a symlink",
        };
    }
    io_error(
        "opening source file beneath repository root",
        display_path,
        source,
    )
}

#[cfg(unix)]
fn stable_file_id(metadata: &Metadata) -> StableFileId {
    StableFileId {
        dev: metadata.dev(),
        ino: metadata.ino(),
    }
}

#[cfg(not(unix))]
fn stable_file_id(_metadata: &Metadata) -> StableFileId {
    StableFileId
}

#[cfg(unix)]
fn stable_source_identity(metadata: &Metadata) -> StableSourceIdentity {
    StableSourceIdentity {
        file_id: stable_file_id(metadata),
        len: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    }
}

#[cfg(not(unix))]
fn stable_source_identity(metadata: &Metadata) -> StableSourceIdentity {
    StableSourceIdentity {
        file_id: stable_file_id(metadata),
        len: metadata.len(),
        modified: metadata.modified().ok(),
    }
}

fn update_sha256_length_prefix(hasher: &mut Sha256, mut length: u64) {
    let mut digits = [0u8; 20];
    let mut start = digits.len();
    loop {
        start -= 1;
        digits[start] = b'0' + u8::try_from(length % 10).expect("decimal digit fits in u8");
        length /= 10;
        if length == 0 {
            break;
        }
    }
    hasher.update(&digits[start..]);
    hasher.update(b":");
}

fn snapshot_from_metadata(metadata: &Metadata) -> SourceSnapshot {
    SourceSnapshot {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    }
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, KernelError> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let cwd = std::env::current_dir()
        .map_err(|source| io_error("reading current directory", Path::new("."), source))?;
    Ok(cwd.join(path))
}

fn sync_parent(parent: &Path) -> Result<(), KernelError> {
    let directory = File::open(parent)
        .map_err(|source| io_error("opening index parent directory", parent, source))?;
    directory
        .sync_all()
        .map_err(|source| io_error("syncing index parent directory", parent, source))
}

fn copy_and_hash(
    reader: &mut impl Read,
    writer: &mut impl Write,
) -> io::Result<(u64, [u8; CHECKSUM_LEN])> {
    let mut buffer = vec![0u8; 64 * 1024].into_boxed_slice();
    let mut total = 0u64;
    let mut hasher = blake3::Hasher::new();
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        total = total
            .checked_add(
                u64::try_from(read)
                    .map_err(|_| io::Error::other("source read length does not fit u64"))?,
            )
            .ok_or_else(|| io::Error::other("source copy length overflow"))?;
    }
    Ok((total, *hasher.finalize().as_bytes()))
}

pub(crate) fn pack_gram(bytes: &[u8]) -> u32 {
    debug_assert!(bytes.len() >= 3);
    (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2])
}

fn is_indexed_gram(gram: u32) -> bool {
    gram.to_be_bytes()[1..]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

fn checked_add(left: u64, right: u64) -> Result<u64, KernelError> {
    left.checked_add(right).ok_or(KernelError::TooLarge)
}

fn checked_mul(left: u64, right: u64) -> Result<u64, KernelError> {
    left.checked_mul(right).ok_or(KernelError::TooLarge)
}

fn io_error(operation: &'static str, path: impl AsRef<Path>, source: io::Error) -> KernelError {
    KernelError::Io {
        operation,
        path: path.as_ref().to_path_buf(),
        source,
    }
}

#[allow(unsafe_code)]
fn map_index_read_only(file: &File, length: usize) -> io::Result<Mmap> {
    // SAFETY: pi-fast-grep owns this immutable generation. Builders publish a
    // completed generation with an atomic rename and never mutate or truncate
    // an inode after publication; replacing the path creates a new inode while
    // existing mappings keep the old generation alive.
    unsafe { MmapOptions::new().len(length).map(file) }
}

struct HashingWriter<W: Write> {
    writer: BufWriter<W>,
    hasher: blake3::Hasher,
}

impl<W: Write> HashingWriter<W> {
    fn new(writer: W) -> Self {
        Self {
            writer: BufWriter::with_capacity(INDEX_WRITE_BUFFER_LEN, writer),
            hasher: blake3::Hasher::new(),
        }
    }

    fn finish(mut self) -> io::Result<[u8; CHECKSUM_LEN]> {
        self.writer.flush()?;
        Ok(*self.hasher.finalize().as_bytes())
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = self.writer.write(buffer)?;
        self.hasher.update(&buffer[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

fn encode_header(header: Header) -> [u8; HEADER_LEN] {
    let mut bytes = [0u8; HEADER_LEN];
    bytes[0..8].copy_from_slice(MAGIC);
    put_u32(&mut bytes, 8, header.format_version);
    put_u32(&mut bytes, 12, HEADER_LEN_U32);
    put_u64(&mut bytes, 16, header.file_count);
    put_u64(&mut bytes, 24, header.gram_count);
    put_u64(&mut bytes, 32, header.posting_count);
    put_u64(&mut bytes, 40, header.binary_file_count);
    put_u64(&mut bytes, 48, header.file_table_offset);
    put_u64(&mut bytes, 56, header.file_table_len);
    put_u64(&mut bytes, 64, header.gram_table_offset);
    put_u64(&mut bytes, 72, header.gram_table_len);
    put_u64(&mut bytes, 80, header.postings_offset);
    put_u64(&mut bytes, 88, header.postings_len);
    put_u64(&mut bytes, 96, header.paths_offset);
    put_u64(&mut bytes, 104, header.paths_len);
    put_u64(&mut bytes, 112, header.contents_offset);
    put_u64(&mut bytes, 120, header.contents_len);
    put_u64(&mut bytes, 128, header.total_len);
    bytes[PAYLOAD_CHECKSUM_OFFSET..PAYLOAD_CHECKSUM_OFFSET + CHECKSUM_LEN]
        .copy_from_slice(&header.payload_checksum);
    let checksum = blake3::hash(&bytes);
    bytes[HEADER_CHECKSUM_OFFSET..HEADER_CHECKSUM_OFFSET + CHECKSUM_LEN]
        .copy_from_slice(checksum.as_bytes());
    bytes
}

fn decode_and_validate_header(bytes: &[u8]) -> Result<Header, KernelError> {
    let raw = bytes
        .get(..HEADER_LEN)
        .ok_or_else(|| KernelError::Corrupt("missing header".into()))?;
    if raw.get(0..8) != Some(MAGIC.as_slice()) {
        return Err(KernelError::Corrupt("magic does not match".into()));
    }
    let format_version = read_u32(raw, 8)?;
    if !matches!(
        format_version,
        FORMAT_VERSION_V1
            | FORMAT_VERSION_V2
            | FORMAT_VERSION_V3
            | FORMAT_VERSION_V4
            | FORMAT_VERSION_V5
    ) {
        return Err(KernelError::Corrupt("format version is unsupported".into()));
    }
    if read_u32(raw, 12)? != HEADER_LEN_U32 {
        return Err(KernelError::Corrupt("header length does not match".into()));
    }
    let mut checksum_input = [0u8; HEADER_LEN];
    checksum_input.copy_from_slice(raw);
    let expected_header_checksum: [u8; CHECKSUM_LEN] = checksum_input
        [HEADER_CHECKSUM_OFFSET..HEADER_CHECKSUM_OFFSET + CHECKSUM_LEN]
        .try_into()
        .expect("fixed checksum range");
    checksum_input[HEADER_CHECKSUM_OFFSET..HEADER_CHECKSUM_OFFSET + CHECKSUM_LEN].fill(0);
    if blake3::hash(&checksum_input).as_bytes() != &expected_header_checksum {
        return Err(KernelError::Corrupt(
            "header checksum does not match".into(),
        ));
    }
    let payload_checksum = raw[PAYLOAD_CHECKSUM_OFFSET..PAYLOAD_CHECKSUM_OFFSET + CHECKSUM_LEN]
        .try_into()
        .expect("fixed checksum range");
    Ok(Header {
        format_version,
        file_count: read_u64(raw, 16)?,
        gram_count: read_u64(raw, 24)?,
        posting_count: read_u64(raw, 32)?,
        binary_file_count: read_u64(raw, 40)?,
        file_table_offset: read_u64(raw, 48)?,
        file_table_len: read_u64(raw, 56)?,
        gram_table_offset: read_u64(raw, 64)?,
        gram_table_len: read_u64(raw, 72)?,
        postings_offset: read_u64(raw, 80)?,
        postings_len: read_u64(raw, 88)?,
        paths_offset: read_u64(raw, 96)?,
        paths_len: read_u64(raw, 104)?,
        contents_offset: read_u64(raw, 112)?,
        contents_len: read_u64(raw, 120)?,
        total_len: read_u64(raw, 128)?,
        payload_checksum,
    })
}

#[derive(Clone, Copy)]
enum AutomaticEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

fn automatic_encoding(content: &[u8]) -> Option<AutomaticEncoding> {
    if content.starts_with(&[0xef, 0xbb, 0xbf]) {
        Some(AutomaticEncoding::Utf8)
    } else if content.starts_with(&[0xff, 0xfe]) {
        Some(AutomaticEncoding::Utf16Le)
    } else if content.starts_with(&[0xfe, 0xff]) {
        Some(AutomaticEncoding::Utf16Be)
    } else {
        None
    }
}

fn decoded_content_contains_nul(content: &[u8], encoding: AutomaticEncoding) -> bool {
    match encoding {
        AutomaticEncoding::Utf8 => memchr(0, &content[3..]).is_some(),
        AutomaticEncoding::Utf16Le | AutomaticEncoding::Utf16Be => content[2..]
            .chunks_exact(2)
            .any(|code_unit| code_unit == [0, 0]),
    }
}

fn decode_content(
    bytes: &[u8],
    header: Header,
    record: FileRecord,
) -> Result<Cow<'_, [u8]>, KernelError> {
    let offset = checked_add(header.contents_offset, record.content_offset)?;
    let stored = slice_at(bytes, offset, record.stored_len)?;
    if record.flags & FLAG_COMPRESSED == 0 {
        return Ok(Cow::Borrowed(stored));
    }
    let content_len = usize::try_from(record.content_len).map_err(|_| KernelError::TooLarge)?;
    let mut content = vec![0; content_len];
    let decoded = lz4_flex::block::decompress_into(stored, &mut content)
        .map_err(|error| KernelError::Corrupt(format!("compressed content is invalid: {error}")))?;
    if decoded != content_len {
        return Err(KernelError::Corrupt(
            "compressed content length does not match".into(),
        ));
    }
    Ok(Cow::Owned(content))
}

#[allow(clippy::too_many_lines)]
fn validate_payload(bytes: &[u8], header: Header) -> Result<ValidatedPayload, KernelError> {
    let actual_len = u64::try_from(bytes.len()).map_err(|_| KernelError::TooLarge)?;
    if header.total_len != actual_len {
        return Err(KernelError::Corrupt(
            "recorded file length does not match".into(),
        ));
    }
    let expected_file_table_len = checked_mul(header.file_count, FILE_RECORD_LEN as u64)?;
    let expected_fixed_gram_table_len = if header.format_version == FORMAT_VERSION_V5 {
        None
    } else {
        Some(checked_mul(
            header.gram_count,
            gram_record_len(header.format_version)?,
        )?)
    };
    let expected_fixed_postings_len = if matches!(
        header.format_version,
        FORMAT_VERSION_V3 | FORMAT_VERSION_V4 | FORMAT_VERSION_V5
    ) {
        None
    } else {
        Some(checked_mul(header.posting_count, 4)?)
    };
    let v1_layout = header.file_table_offset == HEADER_LEN as u64
        && header.gram_table_offset
            == checked_add(header.file_table_offset, header.file_table_len)?
        && header.postings_offset == checked_add(header.gram_table_offset, header.gram_table_len)?
        && header.paths_offset == checked_add(header.postings_offset, header.postings_len)?
        && header.contents_offset == checked_add(header.paths_offset, header.paths_len)?
        && header.total_len == checked_add(header.contents_offset, header.contents_len)?;
    let v2_layout = header.contents_offset == HEADER_LEN as u64
        && header.file_table_offset == checked_add(header.contents_offset, header.contents_len)?
        && header.gram_table_offset
            == checked_add(header.file_table_offset, header.file_table_len)?
        && header.postings_offset == checked_add(header.gram_table_offset, header.gram_table_len)?
        && header.paths_offset == checked_add(header.postings_offset, header.postings_len)?
        && header.total_len == checked_add(header.paths_offset, header.paths_len)?;
    let layout_matches_version = match header.format_version {
        FORMAT_VERSION_V1 => v1_layout,
        FORMAT_VERSION_V2 | FORMAT_VERSION_V3 | FORMAT_VERSION_V4 | FORMAT_VERSION_V5 => v2_layout,
        _ => false,
    };
    if header.file_table_len != expected_file_table_len
        || expected_fixed_gram_table_len.is_some_and(|expected| header.gram_table_len != expected)
        || expected_fixed_postings_len.is_some_and(|expected| header.postings_len != expected)
        || (matches!(
            header.format_version,
            FORMAT_VERSION_V3 | FORMAT_VERSION_V4 | FORMAT_VERSION_V5
        ) && header.postings_len > u64::from(u32::MAX))
        || !layout_matches_version
    {
        return Err(KernelError::Corrupt(
            "section layout is inconsistent".into(),
        ));
    }
    let payload = bytes
        .get(HEADER_LEN..)
        .ok_or_else(|| KernelError::Corrupt("payload is missing".into()))?;
    if blake3::hash(payload).as_bytes() != &header.payload_checksum {
        return Err(KernelError::Corrupt(
            "payload checksum does not match".into(),
        ));
    }

    let mut previous_path: Option<&[u8]> = None;
    let mut observed_binary = 0u64;
    let mut expected_path_offset = 0u64;
    let mut expected_content_offset = 0u64;
    let mut transcoded_file_ids = TranscodedFileIds::default();
    let mut unicode_ascii_fold_file_ids = UnicodeAsciiFoldFileIds::default();
    for file_index in 0..header.file_count {
        let offset = checked_add(
            header.file_table_offset,
            checked_mul(file_index, FILE_RECORD_LEN as u64)?,
        )?;
        let record = decode_file_record(
            slice_at(bytes, offset, FILE_RECORD_LEN as u64)?,
            header.format_version,
        )?;
        let allowed_flags =
            if matches!(header.format_version, FORMAT_VERSION_V4 | FORMAT_VERSION_V5) {
                FLAG_BINARY | FLAG_COMPRESSED
            } else {
                FLAG_BINARY
            };
        if record.flags & !allowed_flags != 0 {
            return Err(KernelError::Corrupt("file record has unknown flags".into()));
        }
        let compressed = record.flags & FLAG_COMPRESSED != 0;
        if (compressed && (record.stored_len == 0 || record.stored_len >= record.content_len))
            || (!compressed && record.stored_len != record.content_len)
        {
            return Err(KernelError::Corrupt(
                "file record stored length is inconsistent".into(),
            ));
        }
        if record.path_offset != expected_path_offset
            || checked_add(record.path_offset, u64::from(record.path_len))? > header.paths_len
            || record.content_offset != expected_content_offset
            || checked_add(record.content_offset, record.stored_len)? > header.contents_len
        {
            return Err(KernelError::Corrupt(
                "file records do not cover their blobs contiguously".into(),
            ));
        }
        let path_bytes = slice_at(
            bytes,
            checked_add(header.paths_offset, record.path_offset)?,
            u64::from(record.path_len),
        )?;
        let path = std::str::from_utf8(path_bytes)
            .map_err(|_| KernelError::Corrupt("file path is not valid UTF-8".into()))?;
        validate_relative_path(path)
            .map_err(|error| KernelError::Corrupt(format!("invalid persisted path: {error}")))?;
        if previous_path.is_some_and(|previous| previous >= path_bytes) {
            return Err(KernelError::Corrupt(
                "file paths are not strictly byte-sorted".into(),
            ));
        }
        previous_path = Some(path_bytes);
        let content = decode_content(bytes, header, record)?;
        let file_id = u32::try_from(file_index).map_err(|_| KernelError::TooLarge)?;
        if memmem::find(&content, "K".as_bytes()).is_some() {
            unicode_ascii_fold_file_ids.kelvin_sign.push(file_id);
        }
        if memmem::find(&content, "ſ".as_bytes()).is_some() {
            unicode_ascii_fold_file_ids.long_s.push(file_id);
        }
        if let Some(encoding) = automatic_encoding(&content) {
            if decoded_content_contains_nul(&content, encoding) {
                transcoded_file_ids.decoded_nul.push(file_id);
            } else {
                transcoded_file_ids.safe.push(file_id);
                if matches!(encoding, AutomaticEncoding::Utf8)
                    && std::str::from_utf8(&content[3..]).is_ok()
                {
                    transcoded_file_ids.utf8_bom.push(file_id);
                }
            }
        }
        let actual_nul = memchr(0, &content)
            .map(|offset| u64::try_from(offset).map_err(|_| KernelError::TooLarge))
            .transpose()?;
        match (
            record.flags & FLAG_BINARY != 0,
            record.first_nul,
            actual_nul,
        ) {
            (false, NO_NUL, None) => {}
            (true, persisted, Some(actual)) if persisted == actual => {
                observed_binary = checked_add(observed_binary, 1)?;
            }
            _ => {
                return Err(KernelError::Corrupt(
                    "binary marker is inconsistent with content".into(),
                ));
            }
        }
        expected_path_offset = checked_add(record.path_offset, u64::from(record.path_len))?;
        expected_content_offset = checked_add(record.content_offset, record.stored_len)?;
    }
    if observed_binary != header.binary_file_count {
        return Err(KernelError::Corrupt(
            "binary file count does not match records".into(),
        ));
    }
    if expected_path_offset != header.paths_len || expected_content_offset != header.contents_len {
        return Err(KernelError::Corrupt(
            "file records do not cover the complete path/content blobs".into(),
        ));
    }

    let mut variable_gram_records = if header.format_version == FORMAT_VERSION_V5 {
        Some(decode_variable_gram_table(bytes, header)?)
    } else {
        None
    };
    let mut previous_key: Option<u32> = None;
    let mut expected_posting_offset = 0u64;
    let mut observed_posting_count = 0u64;
    let fixed_record_len = if variable_gram_records.is_some() {
        None
    } else {
        Some(gram_record_len(header.format_version)?)
    };
    for gram_index in 0..header.gram_count {
        let mut record = if let Some(records) = variable_gram_records.as_ref() {
            records
                .get(usize::try_from(gram_index).map_err(|_| KernelError::TooLarge)?)
                .copied()
                .ok_or_else(|| KernelError::Corrupt("variable gram record is missing".into()))?
        } else {
            let record_len = fixed_record_len.expect("fixed format has a record length");
            let offset = checked_add(
                header.gram_table_offset,
                checked_mul(gram_index, record_len)?,
            )?;
            decode_gram_record_for_format(
                slice_at(bytes, offset, record_len)?,
                header.format_version,
            )?
        };
        if header.format_version == FORMAT_VERSION_V5 {
            record.postings_offset = expected_posting_offset;
        }
        if record.key > 0x00ff_ffff
            || record.postings_count == 0
            || record.postings_count > header.file_count
            || previous_key.is_some_and(|previous| previous >= record.key)
            || (matches!(
                header.format_version,
                FORMAT_VERSION_V3 | FORMAT_VERSION_V4 | FORMAT_VERSION_V5
            ) && !is_indexed_gram(record.key))
            || record.postings_offset != expected_posting_offset
        {
            return Err(KernelError::Corrupt(
                "gram table is not strictly sorted and contiguous".into(),
            ));
        }
        previous_key = Some(record.key);
        if matches!(
            header.format_version,
            FORMAT_VERSION_V3 | FORMAT_VERSION_V4 | FORMAT_VERSION_V5
        ) {
            let (_, consumed) = decode_compact_posting_list(bytes, header, record)?;
            expected_posting_offset = checked_add(expected_posting_offset, consumed)?;
            observed_posting_count = checked_add(observed_posting_count, record.postings_count)?;
        } else {
            if checked_add(record.postings_offset, record.postings_count)? > header.posting_count {
                return Err(KernelError::Corrupt(
                    "gram posting range is out of bounds".into(),
                ));
            }
            let mut previous_file_id: Option<u32> = None;
            for posting_index in 0..record.postings_count {
                let absolute_posting = checked_add(record.postings_offset, posting_index)?;
                let byte_offset =
                    checked_add(header.postings_offset, checked_mul(absolute_posting, 4)?)?;
                let file_id = read_u32(slice_at(bytes, byte_offset, 4)?, 0)?;
                if u64::from(file_id) >= header.file_count
                    || previous_file_id.is_some_and(|previous| previous >= file_id)
                {
                    return Err(KernelError::Corrupt(
                        "postings are not strictly sorted file IDs".into(),
                    ));
                }
                previous_file_id = Some(file_id);
            }
            expected_posting_offset = checked_add(expected_posting_offset, record.postings_count)?;
            observed_posting_count = expected_posting_offset;
        }
        if let Some(records) = variable_gram_records.as_mut() {
            let index = usize::try_from(gram_index).map_err(|_| KernelError::TooLarge)?;
            records[index] = record;
        }
    }
    let expected_section_len = if matches!(
        header.format_version,
        FORMAT_VERSION_V3 | FORMAT_VERSION_V4 | FORMAT_VERSION_V5
    ) {
        header.postings_len
    } else {
        header.posting_count
    };
    if expected_posting_offset != expected_section_len
        || observed_posting_count != header.posting_count
    {
        return Err(KernelError::Corrupt(
            "gram postings do not cover the postings section".into(),
        ));
    }
    Ok(ValidatedPayload {
        transcoded_file_ids,
        unicode_ascii_fold_file_ids,
        variable_gram_records,
    })
}

fn encode_file_record(record: FileRecord, format_version: u32) -> [u8; FILE_RECORD_LEN] {
    let mut bytes = [0u8; FILE_RECORD_LEN];
    put_u64(&mut bytes, 0, record.path_offset);
    put_u32(&mut bytes, 8, record.path_len);
    put_u32(&mut bytes, 12, record.flags);
    put_u64(&mut bytes, 16, record.content_offset);
    put_u64(&mut bytes, 24, record.content_len);
    put_u64(&mut bytes, 32, record.first_nul);
    if matches!(format_version, FORMAT_VERSION_V4 | FORMAT_VERSION_V5) {
        put_u64(&mut bytes, 40, record.stored_len);
    }
    bytes
}

fn decode_file_record(bytes: &[u8], format_version: u32) -> Result<FileRecord, KernelError> {
    if bytes.len() != FILE_RECORD_LEN {
        return Err(KernelError::Corrupt("file record length is invalid".into()));
    }
    let content_len = read_u64(bytes, 24)?;
    let stored_len = if matches!(format_version, FORMAT_VERSION_V4 | FORMAT_VERSION_V5) {
        read_u64(bytes, 40)?
    } else {
        if bytes[40..48].iter().any(|byte| *byte != 0) {
            return Err(KernelError::Corrupt(
                "file record reserved bytes are nonzero".into(),
            ));
        }
        content_len
    };
    Ok(FileRecord {
        path_offset: read_u64(bytes, 0)?,
        path_len: read_u32(bytes, 8)?,
        flags: read_u32(bytes, 12)?,
        content_offset: read_u64(bytes, 16)?,
        content_len,
        first_nul: read_u64(bytes, 32)?,
        stored_len,
    })
}

fn gram_record_len(format_version: u32) -> Result<u64, KernelError> {
    match format_version {
        FORMAT_VERSION_V1 | FORMAT_VERSION_V2 => Ok(GRAM_RECORD_LEN as u64),
        FORMAT_VERSION_V3 | FORMAT_VERSION_V4 => Ok(COMPACT_GRAM_RECORD_LEN as u64),
        _ => Err(KernelError::Corrupt("format version is unsupported".into())),
    }
}

fn encode_gram_record(record: GramRecord) -> [u8; GRAM_RECORD_LEN] {
    let mut bytes = [0u8; GRAM_RECORD_LEN];
    put_u32(&mut bytes, 0, record.key);
    put_u64(&mut bytes, 8, record.postings_offset);
    put_u64(&mut bytes, 16, record.postings_count);
    bytes
}

fn encode_compact_gram_record(
    record: GramRecord,
) -> Result<[u8; COMPACT_GRAM_RECORD_LEN], KernelError> {
    let mut bytes = [0u8; COMPACT_GRAM_RECORD_LEN];
    put_u32(&mut bytes, 0, record.key);
    put_u32(
        &mut bytes,
        4,
        u32::try_from(record.postings_offset).map_err(|_| KernelError::TooLarge)?,
    );
    put_u32(
        &mut bytes,
        8,
        u32::try_from(record.postings_count).map_err(|_| KernelError::TooLarge)?,
    );
    Ok(bytes)
}

fn decode_gram_record(bytes: &[u8]) -> Result<GramRecord, KernelError> {
    if bytes.len() != GRAM_RECORD_LEN || bytes[4..8].iter().any(|byte| *byte != 0) {
        return Err(KernelError::Corrupt(
            "gram record reserved bytes are nonzero".into(),
        ));
    }
    Ok(GramRecord {
        key: read_u32(bytes, 0)?,
        postings_offset: read_u64(bytes, 8)?,
        postings_count: read_u64(bytes, 16)?,
    })
}

fn decode_gram_record_for_format(
    bytes: &[u8],
    format_version: u32,
) -> Result<GramRecord, KernelError> {
    if !matches!(format_version, FORMAT_VERSION_V3 | FORMAT_VERSION_V4) {
        return decode_gram_record(bytes);
    }
    if bytes.len() != COMPACT_GRAM_RECORD_LEN {
        return Err(KernelError::Corrupt(
            "compact gram record length is invalid".into(),
        ));
    }
    Ok(GramRecord {
        key: read_u32(bytes, 0)?,
        postings_offset: u64::from(read_u32(bytes, 4)?),
        postings_count: u64::from(read_u32(bytes, 8)?),
    })
}

fn encode_varint(mut value: u64, output: &mut Vec<u8>) {
    loop {
        let low = u8::try_from(value & 0x7f).expect("seven bits fit in u8");
        value >>= 7;
        if value == 0 {
            output.push(low);
            return;
        }
        output.push(low | 0x80);
    }
}

fn decode_varint(bytes: &[u8], cursor: &mut usize) -> Result<u64, KernelError> {
    let mut value = 0u64;
    for group in 0..10usize {
        let byte = *bytes
            .get(*cursor)
            .ok_or_else(|| KernelError::Corrupt("compact varint is truncated".into()))?;
        *cursor = cursor.checked_add(1).ok_or(KernelError::TooLarge)?;
        let low = u64::from(byte & 0x7f);
        if group == 9 && low > 1 {
            return Err(KernelError::Corrupt("compact varint overflows u64".into()));
        }
        value |= low << (group * 7);
        if byte & 0x80 == 0 {
            if group > 0 && low == 0 {
                return Err(KernelError::Corrupt(
                    "compact varint is not canonical".into(),
                ));
            }
            return Ok(value);
        }
    }
    Err(KernelError::Corrupt("compact varint is too long".into()))
}

fn decode_variable_gram_table(
    bytes: &[u8],
    header: Header,
) -> Result<Vec<GramRecord>, KernelError> {
    let table = slice_at(bytes, header.gram_table_offset, header.gram_table_len)?;
    let capacity = usize::try_from(header.gram_count).map_err(|_| KernelError::TooLarge)?;
    let mut records = Vec::with_capacity(capacity);
    let mut cursor = 0usize;
    let mut previous_key = None;
    for _ in 0..header.gram_count {
        let delta = decode_varint(table, &mut cursor)?;
        let key = match previous_key {
            None if delta > 0 => delta - 1,
            Some(previous) if delta > 0 => checked_add(previous, delta)?,
            _ => {
                return Err(KernelError::Corrupt(
                    "variable gram key delta must be positive".into(),
                ));
            }
        };
        if key > 0x00ff_ffff {
            return Err(KernelError::Corrupt(
                "variable gram key is out of bounds".into(),
            ));
        }
        let postings_count = decode_varint(table, &mut cursor)?;
        if postings_count == 0
            || postings_count > header.file_count
            || postings_count > u64::from(u32::MAX)
        {
            return Err(KernelError::Corrupt(
                "variable gram posting count is out of bounds".into(),
            ));
        }
        let key = u32::try_from(key).map_err(|_| KernelError::TooLarge)?;
        records.push(GramRecord {
            key,
            postings_offset: 0,
            postings_count,
        });
        previous_key = Some(u64::from(key));
    }
    if cursor != table.len() {
        return Err(KernelError::Corrupt(
            "variable gram records do not cover the gram table".into(),
        ));
    }
    Ok(records)
}

fn decode_compact_posting_list(
    bytes: &[u8],
    header: Header,
    record: GramRecord,
) -> Result<(Vec<u32>, u64), KernelError> {
    if record.postings_offset > header.postings_len {
        return Err(KernelError::Corrupt(
            "compact posting offset is out of bounds".into(),
        ));
    }
    let section_offset = checked_add(header.postings_offset, record.postings_offset)?;
    let section = slice_at(
        bytes,
        section_offset,
        header.postings_len - record.postings_offset,
    )?;
    let capacity = usize::try_from(record.postings_count).map_err(|_| KernelError::TooLarge)?;
    let mut file_ids = Vec::with_capacity(capacity);
    let mut cursor = 0usize;
    let mut previous = None;
    for _ in 0..record.postings_count {
        let delta = decode_varint(section, &mut cursor)?;
        let file_id = match previous {
            None if delta > 0 => delta - 1,
            Some(value) if delta > 0 => checked_add(value, delta)?,
            _ => {
                return Err(KernelError::Corrupt(
                    "compact posting delta must be positive".into(),
                ));
            }
        };
        if file_id >= header.file_count || file_id > u64::from(u32::MAX) {
            return Err(KernelError::Corrupt(
                "compact posting file ID is out of bounds".into(),
            ));
        }
        let file_id = u32::try_from(file_id).map_err(|_| KernelError::TooLarge)?;
        if previous.is_some_and(|value| value >= u64::from(file_id)) {
            return Err(KernelError::Corrupt(
                "compact postings are not strictly sorted file IDs".into(),
            ));
        }
        previous = Some(u64::from(file_id));
        file_ids.push(file_id);
    }
    Ok((
        file_ids,
        u64::try_from(cursor).map_err(|_| KernelError::TooLarge)?,
    ))
}

fn slice_at(bytes: &[u8], offset: u64, length: u64) -> Result<&[u8], KernelError> {
    let start = usize::try_from(offset).map_err(|_| KernelError::TooLarge)?;
    let len = usize::try_from(length).map_err(|_| KernelError::TooLarge)?;
    let end = start.checked_add(len).ok_or(KernelError::TooLarge)?;
    bytes
        .get(start..end)
        .ok_or_else(|| KernelError::Corrupt("record range is out of bounds".into()))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, KernelError> {
    let raw = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| KernelError::Corrupt("u32 field is out of bounds".into()))?;
    Ok(u32::from_le_bytes(
        raw.try_into().expect("fixed u32 length"),
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, KernelError> {
    let raw = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| KernelError::Corrupt("u64 field is out of bounds".into()))?;
    Ok(u64::from_le_bytes(
        raw.try_into().expect("fixed u64 length"),
    ))
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use filetime::{FileTime, set_file_mtime};
    use std::fs::{self, OpenOptions};
    use std::io::{self, Seek, SeekFrom, Write};
    use tempfile::TempDir;

    use super::*;

    fn write(root: &Path, relative: &str, bytes: &[u8]) {
        let target = root.join(relative);
        fs::create_dir_all(target.parent().expect("fixture parent"))
            .expect("create fixture parent");
        fs::write(target, bytes).expect("write fixture");
    }

    fn build_fixture() -> (TempDir, PathBuf, Vec<String>) {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "A-upper.txt", b"needle one\nneedle two\n");
        write(directory.path(), "src/b.txt", b"prefix needle suffix\n");
        write(directory.path(), "src/c.txt", b"nothing here\n");
        let index = directory.path().join(".pi/index/core.pfg");
        let paths = vec![
            "src/c.txt".to_owned(),
            "src/b.txt".to_owned(),
            "A-upper.txt".to_owned(),
        ];
        (directory, index, paths)
    }

    #[derive(Default)]
    struct CountingWriter {
        bytes: Vec<u8>,
        write_calls: usize,
        flush_calls: usize,
        max_write: usize,
    }

    impl Write for CountingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.write_calls += 1;
            self.max_write = self.max_write.max(buffer.len());
            self.bytes.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flush_calls += 1;
            Ok(())
        }
    }

    struct ShortWriter {
        bytes: Vec<u8>,
        maximum: usize,
    }

    impl Write for ShortWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            let accepted = buffer.len().min(self.maximum);
            self.bytes.extend_from_slice(&buffer[..accepted]);
            Ok(accepted)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct FlushFailingWriter {
        bytes: Vec<u8>,
    }

    impl Write for FlushFailingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::other("injected flush failure"))
        }
    }

    fn source_digest(root: &Path, paths: &[&str]) -> SourceContentDigest {
        let canonical_root = fs::canonicalize(root).expect("canonical root");
        let mut digester =
            SourceContentDigester::new(root, canonical_root).expect("create source digester");
        for relative_path in paths {
            digester.add(relative_path).expect("digest source path");
        }
        digester.finish().expect("finish source digest")
    }

    fn isolated_trusted_source_digest(root: &Path, paths: &[&str]) -> SourceContentDigest {
        let canonical_root = fs::canonicalize(root).expect("canonical root");
        let mut digester =
            SourceContentDigester::new(root, canonical_root).expect("create source digester");
        for relative_path in paths {
            digester
                .add_isolated_trusted(relative_path)
                .expect("digest isolated trusted source path");
        }
        digester.finish().expect("finish source digest")
    }

    fn naive_non_overlapping(bytes: &[u8], needle: &[u8]) -> Vec<(u64, u64)> {
        let finder = memmem::Finder::new(needle);
        let mut result = Vec::new();
        let mut cursor = 0usize;
        while cursor <= bytes.len().saturating_sub(needle.len()) {
            let Some(relative) = finder.find(&bytes[cursor..]) else {
                break;
            };
            let start = cursor + relative;
            let end = start + needle.len();
            result.push((start as u64, end as u64));
            cursor = end;
        }
        result
    }

    #[test]
    fn payload_writer_buffers_tiny_writes_and_preserves_large_write_bytes() {
        let mut expected = Vec::new();
        let mut sink = CountingWriter::default();
        let checksum = {
            let mut writer = HashingWriter::new(&mut sink);
            for value in 0..4096u32 {
                let bytes = value.to_le_bytes();
                expected.extend_from_slice(&bytes);
                writer.write_all(&bytes).expect("write tiny record");
            }
            let large = vec![b'x'; INDEX_WRITE_BUFFER_LEN * 2 + 17];
            expected.extend_from_slice(&large);
            writer.write_all(&large).expect("write large payload");
            writer.finish().expect("flush payload")
        };
        assert_eq!(sink.bytes, expected);
        assert_eq!(checksum, *blake3::hash(&expected).as_bytes());
        assert!(
            sink.write_calls <= 2,
            "tiny records and one large payload should be coalesced"
        );
        assert_eq!(sink.flush_calls, 1);
        assert!(sink.max_write >= INDEX_WRITE_BUFFER_LEN * 2);
    }

    #[test]
    fn payload_writer_hashes_only_bytes_accepted_by_short_writes() {
        let expected = vec![b's'; INDEX_WRITE_BUFFER_LEN * 2 + 17];
        let mut sink = ShortWriter {
            bytes: Vec::new(),
            maximum: 3,
        };
        let checksum = {
            let mut writer = HashingWriter::new(&mut sink);
            writer.write_all(&expected).expect("write payload");
            writer.finish().expect("flush payload")
        };
        assert_eq!(sink.bytes, expected);
        assert_eq!(checksum, *blake3::hash(&expected).as_bytes());
    }

    #[test]
    fn payload_writer_propagates_flush_failure() {
        let mut sink = FlushFailingWriter::default();
        let result = {
            let mut writer = HashingWriter::new(&mut sink);
            writer
                .write_all(b"buffered payload")
                .expect("buffer payload");
            writer.finish()
        };
        assert!(result.is_err(), "flush failure must reject the build");
    }

    #[test]
    fn builds_reopens_and_returns_stable_exact_occurrences() {
        let (directory, index_path, paths) = build_fixture();
        let built = build_index(directory.path(), &paths, &index_path).expect("build");
        assert_eq!(built.format_version, FORMAT_VERSION_V1);
        assert_eq!(built.files, 3);
        assert_eq!(built.binary_files, 0);
        assert!(built.grams > 0);
        assert_eq!(
            built.index_bytes,
            fs::metadata(&index_path).expect("metadata").len()
        );

        let (index, opened) = KernelIndex::open(&index_path).expect("open");
        assert_eq!(opened.format_version, FORMAT_VERSION_V1);
        assert_eq!(opened.files, 3);
        assert!(opened.open_duration < Duration::from_secs(1));
        let result = index.query_literal("needle", None).expect("query");
        assert_eq!(result.total_occurrences, 3);
        assert!(!result.requires_fallback);
        assert_eq!(
            result
                .occurrences
                .iter()
                .map(|item| (item.path.as_str(), item.absolute_start, item.absolute_end))
                .collect::<Vec<_>>(),
            vec![
                ("A-upper.txt", 0, 6),
                ("A-upper.txt", 11, 17),
                ("src/b.txt", 7, 13),
            ],
        );
        drop(index);
        KernelIndex::open(&index_path).expect("warm reopen after drop");
    }

    #[test]
    fn sparse_identifier_grams_preserve_literal_recall_with_full_scan_fallback() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "a.txt", b"alpha ::: :::\n");
        write(directory.path(), "b.txt", "snow 雪雪 end\n".as_bytes());
        write(directory.path(), "c.txt", b"alpha only\n");
        let paths = vec!["a.txt".to_owned(), "b.txt".to_owned(), "c.txt".to_owned()];
        let index_path = directory.path().join(".pi/index/sparse.pfg");
        build_index(directory.path(), &paths, &index_path).expect("build sparse index");
        let (index, _) = KernelIndex::open(&index_path).expect("open sparse index");

        assert!(
            index
                .find_gram(pack_gram(b"alp"))
                .expect("find identifier gram")
                .is_some()
        );
        assert!(
            index
                .find_gram(pack_gram(b":::"))
                .expect("find omitted gram")
                .is_none()
        );
        let punctuation = index.query_literal(":::", None).expect("punctuation query");
        assert_eq!(punctuation.candidate_files, 3);
        assert_eq!(punctuation.total_occurrences, 2);
        assert_eq!(
            punctuation
                .occurrences
                .iter()
                .map(|value| (
                    value.path.as_str(),
                    value.absolute_start,
                    value.absolute_end
                ))
                .collect::<Vec<_>>(),
            vec![("a.txt", 6, 9), ("a.txt", 10, 13)],
        );
        let unicode = index.query_literal("雪雪", None).expect("unicode query");
        assert_eq!(unicode.candidate_files, 3);
        assert_eq!(unicode.total_occurrences, 1);
        assert!(
            index
                .query_regex_candidates(":::")
                .expect("punctuation regex plan")
                .is_none(),
            "regexes without an indexed mandatory gram must fail closed to product rg",
        );
    }

    #[test]
    fn fused_build_digest_uses_caller_order_and_preserves_exact_index_bytes() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "A.txt", b"needle alpha\n");
        write(directory.path(), "src/\u{e000}.txt", b"needle private\n");
        write(
            directory.path(),
            "src/\u{1f600}.txt",
            b"needle supplementary\n",
        );
        write(directory.path(), "src/empty.txt", b"");
        write(directory.path(), "src/large.txt", &vec![b'x'; 70_001]);
        write(directory.path(), "src/binary.bin", b"needle\0tail");

        // JavaScript UTF-16 order puts the supplementary path before U+E000;
        // the immutable index deliberately uses UTF-8 byte order instead.
        let caller_paths = vec![
            "src/\u{1f600}.txt".to_owned(),
            "src/empty.txt".to_owned(),
            "A.txt".to_owned(),
            "src/large.txt".to_owned(),
            "src/\u{e000}.txt".to_owned(),
            "src/binary.bin".to_owned(),
        ];
        let baseline_path = directory.path().join(".pi/index/baseline.pfg");
        let fused_path = directory.path().join(".pi/index/fused.pfg");
        let permuted_path = directory.path().join(".pi/index/permuted.pfg");
        let baseline =
            build_index(directory.path(), &caller_paths, &baseline_path).expect("baseline build");
        let fused = build_index_with_source_digest(directory.path(), &caller_paths, &fused_path)
            .expect("fused build");
        let caller_refs = caller_paths.iter().map(String::as_str).collect::<Vec<_>>();
        let expected = source_digest(directory.path(), &caller_refs);
        assert_eq!(fused.content_sha256, expected.content_sha256);
        assert_eq!(fused.source_bytes, expected.source_bytes);
        assert_eq!(
            (
                fused.stats.format_version,
                fused.stats.files,
                fused.stats.binary_files,
                fused.stats.grams,
                fused.stats.postings,
                fused.stats.index_bytes,
            ),
            (
                baseline.format_version,
                baseline.files,
                baseline.binary_files,
                baseline.grams,
                baseline.postings,
                baseline.index_bytes,
            ),
        );
        assert_eq!(
            fs::read(&fused_path).expect("read fused index"),
            fs::read(&baseline_path).expect("read baseline index"),
        );

        let mut permuted_paths = caller_paths.clone();
        permuted_paths.reverse();
        let permuted =
            build_index_with_source_digest(directory.path(), &permuted_paths, &permuted_path)
                .expect("permuted fused build");
        let permuted_refs = permuted_paths
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert_eq!(
            permuted.content_sha256,
            source_digest(directory.path(), &permuted_refs).content_sha256,
        );
        assert_ne!(permuted.content_sha256, fused.content_sha256);
        assert_eq!(
            fs::read(&permuted_path).expect("read permuted index"),
            fs::read(&baseline_path).expect("read baseline index"),
        );
        let duplicate_path = directory.path().join(".pi/index/duplicate.pfg");
        let duplicate = vec!["A.txt".to_owned(), "A.txt".to_owned()];
        assert!(matches!(
            build_index_with_source_digest(directory.path(), &duplicate, &duplicate_path),
            Err(KernelError::InvalidRelativePath { .. })
        ));
        assert!(!duplicate_path.exists());
        let (index, _) = KernelIndex::open(&fused_path).expect("open fused index");
        let query = index
            .query_literal("needle", None)
            .expect("query fused index");
        assert_eq!(query.total_occurrences, 3);
        assert!(query.requires_fallback);
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn byte_sorted_fused_build_uses_deterministic_variable_gram_content_first_v5() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "a.txt", b"needle alpha\n");
        write(directory.path(), "empty.txt", b"");
        write(directory.path(), "src/binary.bin", b"needle\0tail");
        write(directory.path(), "src/large.txt", &vec![b'x'; 70_001]);
        let paths = vec![
            "a.txt".to_owned(),
            "empty.txt".to_owned(),
            "src/binary.bin".to_owned(),
            "src/large.txt".to_owned(),
        ];
        let baseline_path = directory.path().join(".pi/index/baseline-v1.pfg");
        let fused_path = directory.path().join(".pi/index/fused-v5.pfg");
        let repeated_path = directory.path().join(".pi/index/repeated-v5.pfg");
        let baseline =
            build_index(directory.path(), &paths, &baseline_path).expect("baseline v1 build");
        let fused = build_index_with_source_digest(directory.path(), &paths, &fused_path)
            .expect("variable-gram content-first v5 build");
        let repeated = build_index_with_source_digest(directory.path(), &paths, &repeated_path)
            .expect("repeated variable-gram content-first v5 build");
        let path_refs = paths.iter().map(String::as_str).collect::<Vec<_>>();
        let expected_digest = source_digest(directory.path(), &path_refs);

        assert_eq!(baseline.format_version, FORMAT_VERSION_V1);
        assert_eq!(fused.stats.format_version, FORMAT_VERSION_V5);
        assert_eq!(repeated.stats.format_version, FORMAT_VERSION_V5);
        assert_eq!(fused.content_sha256, expected_digest.content_sha256);
        assert_eq!(fused.source_bytes, expected_digest.source_bytes);
        assert_eq!(
            (
                fused.stats.files,
                fused.stats.binary_files,
                fused.stats.grams,
                fused.stats.postings,
            ),
            (
                baseline.files,
                baseline.binary_files,
                baseline.grams,
                baseline.postings,
            ),
        );
        assert!(
            fused.stats.index_bytes < baseline.index_bytes,
            "compact postings and content compression must reduce the persisted index"
        );

        let baseline_bytes = fs::read(&baseline_path).expect("read baseline v1");
        let fused_bytes = fs::read(&fused_path).expect("read fused v5");
        assert_ne!(fused_bytes, baseline_bytes, "the layouts must be distinct");
        assert_eq!(
            fs::read(&repeated_path).expect("read repeated v5"),
            fused_bytes,
            "the v5 bytes must be deterministic",
        );
        let header = decode_and_validate_header(&fused_bytes).expect("decode v5 header");
        assert_eq!(header.format_version, FORMAT_VERSION_V5);
        assert_eq!(header.contents_offset, HEADER_LEN as u64);
        assert!(
            header.contents_len < fused.source_bytes,
            "the content blob must be physically compressed"
        );
        assert_eq!(
            header.file_table_offset,
            header.contents_offset + header.contents_len,
        );
        let empty_record_offset = header.file_table_offset + FILE_RECORD_LEN as u64;
        let empty_record = decode_file_record(
            slice_at(&fused_bytes, empty_record_offset, FILE_RECORD_LEN as u64)
                .expect("empty record bytes"),
            FORMAT_VERSION_V5,
        )
        .expect("decode empty record");
        assert_eq!(empty_record.flags & FLAG_COMPRESSED, 0);
        assert_eq!(empty_record.content_len, 0);
        assert_eq!(empty_record.stored_len, 0);
        let large_record_offset = header.file_table_offset + 3 * FILE_RECORD_LEN as u64;
        let large_record = decode_file_record(
            slice_at(&fused_bytes, large_record_offset, FILE_RECORD_LEN as u64)
                .expect("large record bytes"),
            FORMAT_VERSION_V5,
        )
        .expect("decode large record");
        assert_ne!(large_record.flags & FLAG_COMPRESSED, 0);
        assert!(large_record.stored_len < large_record.content_len);
        assert_eq!(header.total_len, header.paths_offset + header.paths_len,);
        assert!(
            header.gram_table_len
                < header.gram_count
                    * u64::try_from(COMPACT_GRAM_RECORD_LEN).expect("constant fits"),
            "variable gram records must beat the v4 fixed-width table"
        );

        let (baseline_index, baseline_opened) = KernelIndex::open(&baseline_path).expect("open v1");
        let (fused_index, fused_opened) = KernelIndex::open(&fused_path).expect("open v5");
        assert_eq!(baseline_opened.format_version, FORMAT_VERSION_V1);
        assert_eq!(fused_opened.format_version, FORMAT_VERSION_V5);
        let baseline_query = baseline_index
            .query_literal("needle", None)
            .expect("query v1");
        let fused_query = fused_index.query_literal("needle", None).expect("query v5");
        assert_eq!(fused_query.occurrences, baseline_query.occurrences);
        assert_eq!(
            fused_query.total_occurrences,
            baseline_query.total_occurrences
        );
        assert_eq!(fused_query.candidate_files, baseline_query.candidate_files);
        assert_eq!(
            fused_query.binary_match_files,
            baseline_query.binary_match_files
        );
        assert_eq!(
            fused_query.requires_fallback,
            baseline_query.requires_fallback
        );

        let corrupt_path = directory.path().join(".pi/index/corrupt-v5.pfg");
        let mut wrong_layout = fused_bytes.clone();
        let mut wrong_layout_header = header;
        wrong_layout_header.file_table_offset += 1;
        wrong_layout[..HEADER_LEN].copy_from_slice(&encode_header(wrong_layout_header));
        fs::write(&corrupt_path, wrong_layout).expect("write wrong-layout v5");
        assert!(matches!(
            KernelIndex::open(&corrupt_path),
            Err(KernelError::Corrupt(_))
        ));

        let mut payload_corrupt = fused_bytes.clone();
        let content_byte =
            usize::try_from(header.contents_offset).expect("fixture content offset fits usize");
        payload_corrupt[content_byte] ^= 0xff;
        fs::write(&corrupt_path, payload_corrupt).expect("write corrupt v5 payload");
        assert!(matches!(
            KernelIndex::open(&corrupt_path),
            Err(KernelError::Corrupt(_))
        ));

        let mut noncanonical_gram = fused_bytes.clone();
        let gram_start = usize::try_from(header.gram_table_offset).expect("gram offset fits usize");
        noncanonical_gram[gram_start] = 0x80;
        noncanonical_gram[gram_start + 1] = 0;
        let mut noncanonical_header = header;
        noncanonical_header.payload_checksum =
            *blake3::hash(&noncanonical_gram[HEADER_LEN..]).as_bytes();
        noncanonical_gram[..HEADER_LEN].copy_from_slice(&encode_header(noncanonical_header));
        fs::write(&corrupt_path, noncanonical_gram).expect("write noncanonical gram table");
        assert!(matches!(
            KernelIndex::open(&corrupt_path),
            Err(KernelError::Corrupt(_))
        ));

        let malformed_header = Header {
            contents_offset: 0,
            contents_len: 1,
            total_len: 1,
            ..header
        };
        let malformed_record = FileRecord {
            path_offset: 0,
            path_len: 0,
            flags: FLAG_COMPRESSED,
            content_offset: 0,
            content_len: 64,
            first_nul: NO_NUL,
            stored_len: 1,
        };
        assert!(matches!(
            decode_content(&[0xff], malformed_header, malformed_record),
            Err(KernelError::Corrupt(_))
        ));

        let mut unsupported = fused_bytes;
        let mut unsupported_header = header;
        unsupported_header.format_version = 6;
        unsupported[..HEADER_LEN].copy_from_slice(&encode_header(unsupported_header));
        fs::write(&corrupt_path, unsupported).expect("write unsupported version");
        assert!(matches!(
            KernelIndex::open(&corrupt_path),
            Err(KernelError::Corrupt(_))
        ));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn trusted_v5_acquisition_preserves_legacy_acquisition_bytes() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "a-empty.txt", b"");
        write(directory.path(), "b-binary.bin", b"binary\0needle");
        write(directory.path(), "c-large.txt", &vec![b'x'; 70 * 1024]);
        write(directory.path(), "d-text.txt", b"needle text\n");
        let paths = vec![
            "a-empty.txt".to_owned(),
            "b-binary.bin".to_owned(),
            "c-large.txt".to_owned(),
            "d-text.txt".to_owned(),
        ];
        let trusted_path = directory.path().join(".pi/index/trusted-v5.pfg");
        let legacy_path = directory.path().join(".pi/index/legacy-v5.pfg");
        let trusted = build_index_with_source_digest(directory.path(), &paths, &trusted_path)
            .expect("trusted v5 build");
        let legacy = build_index_impl_with_trusted_acquisition::<true>(
            directory.path(),
            &paths,
            &legacy_path,
            false,
        )
        .expect("legacy-acquisition v5 build");

        assert_eq!(trusted.stats.format_version, FORMAT_VERSION_V5);
        assert_eq!(legacy.stats.format_version, FORMAT_VERSION_V5);
        assert_eq!(trusted.stats.files, legacy.stats.files);
        assert_eq!(trusted.stats.binary_files, legacy.stats.binary_files);
        assert_eq!(trusted.stats.grams, legacy.stats.grams);
        assert_eq!(trusted.stats.postings, legacy.stats.postings);
        assert_eq!(trusted.stats.index_bytes, legacy.stats.index_bytes);
        assert_eq!(
            trusted.content_sha256,
            legacy.content_sha256.expect("legacy source digest")
        );
        assert_eq!(trusted.source_bytes, legacy.source_bytes);
        assert_eq!(
            fs::read(&trusted_path).expect("read trusted v5"),
            fs::read(&legacy_path).expect("read legacy-acquisition v5"),
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn trusted_v2_acquisition_preserves_symlink_and_fifo_gates() {
        use std::os::unix::fs::symlink;
        use std::process::Command;

        let directory = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        write(
            directory.path(),
            "real-parent/inside.txt",
            b"inside needle\n",
        );
        write(outside.path(), "outside.txt", b"outside needle\n");
        symlink("real-parent", directory.path().join("relative-parent"))
            .expect("relative in-root parent symlink");
        symlink(
            directory.path().join("real-parent"),
            directory.path().join("absolute-parent"),
        )
        .expect("absolute in-root parent symlink");
        symlink(
            outside.path().join("outside.txt"),
            directory.path().join("leaf.txt"),
        )
        .expect("leaf symlink");
        symlink(outside.path(), directory.path().join("outside-parent"))
            .expect("outside parent symlink");

        let accepted_path = directory.path().join(".pi/index/accepted.pfg");
        let accepted = build_index_with_source_digest(
            directory.path(),
            &[
                "absolute-parent/inside.txt".into(),
                "relative-parent/inside.txt".into(),
            ],
            &accepted_path,
        )
        .expect("in-root parent symlinks remain accepted");
        assert_eq!(accepted.stats.format_version, FORMAT_VERSION_V5);
        let (index, _) = KernelIndex::open(&accepted_path).expect("open accepted v5");
        assert_eq!(
            index
                .query_literal("needle", None)
                .expect("query accepted v2")
                .total_occurrences,
            2,
        );

        for relative in ["leaf.txt", "outside-parent/outside.txt"] {
            let result = build_index_with_source_digest(
                directory.path(),
                &[relative.to_owned()],
                directory.path().join(".pi/index/rejected.pfg"),
            );
            assert!(
                matches!(result, Err(KernelError::InvalidRelativePath { .. })),
                "unexpected result for {relative}: {result:?}",
            );
        }

        let fifo_path = directory.path().join("source.fifo");
        let status = Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo failed: {status}");
        let result = build_index_with_source_digest(
            directory.path(),
            &["source.fifo".into()],
            directory.path().join(".pi/index/fifo.pfg"),
        );
        assert!(matches!(
            result,
            Err(KernelError::InvalidRelativePath { .. })
        ));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn trusted_v2_acquisition_preserves_output_entry_semantics() {
        use std::os::unix::fs::symlink;

        let same = tempfile::tempdir().expect("same-path tempdir");
        write(same.path(), "same.pfg", b"same needle\n");
        assert!(matches!(
            build_index_with_source_digest(
                same.path(),
                &["same.pfg".into()],
                same.path().join("same.pfg"),
            ),
            Err(KernelError::InvalidRelativePath { .. })
        ));

        let aliased = tempfile::tempdir().expect("aliased-output tempdir");
        write(aliased.path(), ".pi/index/aliased.pfg", b"aliased needle\n");
        symlink(".pi/index", aliased.path().join("index-alias")).expect("index parent alias");
        assert!(matches!(
            build_index_with_source_digest(
                aliased.path(),
                &["index-alias/aliased.pfg".into()],
                aliased.path().join(".pi/index/aliased.pfg"),
            ),
            Err(KernelError::InvalidRelativePath { .. })
        ));

        let output_symlink = tempfile::tempdir().expect("output-symlink tempdir");
        write(output_symlink.path(), "source.txt", b"source needle\n");
        fs::create_dir_all(output_symlink.path().join(".pi/index")).expect("create output parent");
        let symlink_index = output_symlink.path().join(".pi/index/core.pfg");
        symlink(output_symlink.path().join("source.txt"), &symlink_index)
            .expect("output leaf symlink");
        build_index_with_source_digest(
            output_symlink.path(),
            &["source.txt".into()],
            &symlink_index,
        )
        .expect("replace output symlink entry");
        assert!(
            !fs::symlink_metadata(&symlink_index)
                .expect("output metadata")
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read(output_symlink.path().join("source.txt")).expect("read source target"),
            b"source needle\n",
        );

        let hardlink = tempfile::tempdir().expect("hardlink tempdir");
        write(hardlink.path(), "source.txt", b"hardlink needle\n");
        fs::create_dir_all(hardlink.path().join(".pi/index")).expect("create hardlink parent");
        let hardlink_index = hardlink.path().join(".pi/index/core.pfg");
        fs::hard_link(hardlink.path().join("source.txt"), &hardlink_index)
            .expect("create output hardlink");
        build_index_with_source_digest(hardlink.path(), &["source.txt".into()], &hardlink_index)
            .expect("distinct hardlink path remains accepted");
        assert_eq!(
            fs::read(hardlink.path().join("source.txt")).expect("read hardlink source"),
            b"hardlink needle\n",
        );
        assert_ne!(
            stable_file_id(&fs::metadata(hardlink.path().join("source.txt")).expect("source id")),
            stable_file_id(&fs::metadata(&hardlink_index).expect("index id")),
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn trusted_v2_root_fence_rejects_root_retarget() {
        let parent = tempfile::tempdir().expect("parent tempdir");
        let root = parent.path().join("root");
        fs::create_dir_all(root.join(".pi/index")).expect("create root");
        let canonical_root = fs::canonicalize(&root).expect("canonical root");
        let trusted = TrustedBuildRoot::prepare(
            &root,
            &canonical_root,
            &root.join(".pi/index/core.pfg"),
            &root.join(".pi/index"),
        )
        .expect("prepare trusted root")
        .expect("beneath-root capability");
        fs::rename(&root, parent.path().join("displaced")).expect("displace root");
        fs::create_dir(&root).expect("replace root");
        assert!(matches!(
            trusted.verify(),
            Err(KernelError::SourceChanged(_))
        ));
    }

    #[test]
    fn failed_content_first_build_preserves_the_published_generation() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "a.txt", b"old needle\n");
        let index_path = directory.path().join(".pi/index/core.pfg");
        build_index(directory.path(), &["a.txt".into()], &index_path).expect("publish v1");
        let published = fs::read(&index_path).expect("read published v1");
        let result = build_index_with_source_digest(
            directory.path(),
            &["a.txt".into(), "missing.txt".into()],
            &index_path,
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read(&index_path).expect("read generation after failure"),
            published,
        );
        let (index, opened) = KernelIndex::open(&index_path).expect("reopen old generation");
        assert_eq!(opened.format_version, FORMAT_VERSION_V1);
        assert_eq!(
            index
                .query_literal("needle", None)
                .expect("query old generation")
                .total_occurrences,
            1,
        );
    }

    #[test]
    fn matches_naive_scan_for_many_literals_without_false_negatives() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut paths = Vec::new();
        let mut state = 0x1234_5678_u64;
        for file_index in 0..24 {
            let mut bytes = Vec::with_capacity(512);
            for _ in 0..512 {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                bytes.push(b'a' + u8::try_from((state >> 33) % 6).expect("small alphabet"));
            }
            if file_index % 3 == 0 {
                bytes.extend_from_slice(b"rare-needle");
            }
            let relative = format!("src/file-{file_index:02}.txt");
            write(directory.path(), &relative, &bytes);
            paths.push(relative);
        }
        let v1_path = directory.path().join("index-v1.pfg");
        let v5_path = directory.path().join("index-v5.pfg");
        let v1 = build_index(directory.path(), &paths, &v1_path).expect("build v1");
        let v5 =
            build_index_with_source_digest(directory.path(), &paths, &v5_path).expect("build v5");
        assert_eq!(v1.format_version, FORMAT_VERSION_V1);
        assert_eq!(v5.stats.format_version, FORMAT_VERSION_V5);
        let (v1_index, _) = KernelIndex::open(&v1_path).expect("open v1");
        let (v5_index, _) = KernelIndex::open(&v5_path).expect("open v5");

        for needle in ["abc", "aaaa", "rare-needle", "fedc", "not-present"] {
            let mut expected = Vec::new();
            let mut sorted_paths = paths.clone();
            sorted_paths.sort_unstable();
            for relative in sorted_paths {
                let bytes = fs::read(directory.path().join(&relative)).expect("read fixture");
                for (start, end) in naive_non_overlapping(&bytes, needle.as_bytes()) {
                    expected.push((relative.clone(), start, end));
                }
            }
            for (format, index) in [
                (FORMAT_VERSION_V1, &v1_index),
                (FORMAT_VERSION_V5, &v5_index),
            ] {
                let actual = index.query_literal(needle, None).expect("query");
                let observed = actual
                    .occurrences
                    .iter()
                    .map(|item| (item.path.clone(), item.absolute_start, item.absolute_end))
                    .collect::<Vec<_>>();
                assert_eq!(observed, expected, "format={format}, needle={needle}");
                assert_eq!(
                    usize::try_from(actual.total_occurrences).expect("fixture count fits usize"),
                    expected.len(),
                );
                assert!(!actual.requires_fallback);
            }
        }
    }

    #[test]
    fn variable_gram_content_first_v5_supports_an_empty_universe() {
        let directory = tempfile::tempdir().expect("tempdir");
        let index_path = directory.path().join("empty-v5.pfg");
        let built = build_index_with_source_digest(directory.path(), &[], &index_path)
            .expect("build empty v5");
        assert_eq!(built.stats.format_version, FORMAT_VERSION_V5);
        assert_eq!(built.stats.files, 0);
        assert_eq!(built.source_bytes, 0);
        let (index, opened) = KernelIndex::open(&index_path).expect("open empty v5");
        assert_eq!(opened.format_version, FORMAT_VERSION_V5);
        assert_eq!(
            index
                .query_literal("absent", None)
                .expect("query empty v2")
                .total_occurrences,
            0,
        );
    }

    #[test]
    fn uses_leftmost_non_overlapping_literal_semantics() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "a.txt", b"aaaaa\n");
        let index_path = directory.path().join("index.pfg");
        build_index(directory.path(), &["a.txt".into()], &index_path).expect("build");
        let (index, _) = KernelIndex::open(&index_path).expect("open");
        let result = index.query_literal("aaa", None).expect("query");
        assert_eq!(
            result
                .occurrences
                .iter()
                .map(|item| (item.absolute_start, item.absolute_end))
                .collect::<Vec<_>>(),
            vec![(0, 3)],
        );
    }

    #[test]
    fn literal_glob_subset_preserves_segment_and_recursive_semantics() {
        let basename = LiteralGlob::compile("*.yaml").expect("basename glob");
        assert!(basename.matches("a.yaml"));
        assert!(basename.matches("deep/nested/a.yaml"));
        assert!(!basename.matches("deep/nested/a.yml"));

        let direct = LiteralGlob::compile("configs/*.yaml").expect("anchored direct glob");
        assert!(direct.matches("configs/a.yaml"));
        assert!(!direct.matches("configs/sub/a.yaml"));
        assert!(!direct.matches("other/configs/a.yaml"));

        let recursive = LiteralGlob::compile("configs/**/*.yaml").expect("recursive glob");
        assert!(recursive.matches("configs/a.yaml"));
        assert!(recursive.matches("configs/x/y/a.yaml"));
        assert!(!recursive.matches("other/configs/a.yaml"));

        let leading_recursive = LiteralGlob::compile("**/*.test.ts").expect("leading glob");
        assert!(leading_recursive.matches("a.test.ts"));
        assert!(leading_recursive.matches("x/y/a.test.ts"));

        for unsupported in [
            "!*.yaml",
            "file?.yaml",
            "[ab].yaml",
            "{a,b}.yaml",
            r"escaped\*.yaml",
            "configs/**",
            "configs/foo**bar.yaml",
        ] {
            assert!(
                matches!(
                    LiteralGlob::compile(unsupported),
                    Err(KernelError::UnsupportedLiteral(_))
                ),
                "unsupported glob {unsupported:?}",
            );
        }
    }

    #[test]
    fn counts_every_occurrence_before_applying_a_global_limit() {
        let (directory, index_path, paths) = build_fixture();
        build_index(directory.path(), &paths, &index_path).expect("build");
        let (index, _) = KernelIndex::open(&index_path).expect("open");
        let result = index.query_literal("needle", Some(2)).expect("query");
        assert_eq!(result.total_occurrences, 3);
        assert_eq!(result.occurrences.len(), 2);
        assert!(result.truncated);
        let zero = index.query_literal("needle", Some(0)).expect("query");
        assert_eq!(zero.total_occurrences, 3);
        assert!(zero.occurrences.is_empty());
        assert!(zero.truncated);
    }

    #[test]
    fn binary_exact_candidates_require_fallback_and_are_not_emitted() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "binary.bin", b"needle\0needle");
        write(directory.path(), "text.txt", b"needle\n");
        let index_path = directory.path().join("index.pfg");
        build_index(
            directory.path(),
            &["binary.bin".into(), "text.txt".into()],
            &index_path,
        )
        .expect("build");
        let (index, opened) = KernelIndex::open(&index_path).expect("open");
        assert_eq!(opened.binary_files, 1);
        let result = index.query_literal("needle", None).expect("query");
        assert!(result.requires_fallback);
        assert_eq!(result.binary_match_files, vec!["binary.bin"]);
        assert_eq!(result.total_occurrences, 1);
        assert_eq!(result.occurrences[0].path, "text.txt");
    }

    #[test]
    fn in_process_regex_verifier_is_exact_bounded_and_cancellable() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(
            directory.path(),
            "a.txt",
            b"before\r\nTOKEN(one TOKEN(two\r\nafter\r\n",
        );
        write(directory.path(), "b.txt", b"TOKEN(three\nlast\n");
        write(directory.path(), "bom.txt", b"\xef\xbb\xbfTOKEN(four\n");
        let mut chunk = vec![b'x'; (64 * 1024) - 1];
        chunk.extend_from_slice(b"TOKEN(boundary\n");
        write(directory.path(), "chunk.txt", &chunk);
        let paths = vec![
            "a.txt".into(),
            "b.txt".into(),
            "bom.txt".into(),
            "chunk.txt".into(),
        ];
        let index_path = directory.path().join(".pi/index/verifier.pfg");
        build_index_with_source_digest(directory.path(), &paths, &index_path)
            .expect("build verifier index");
        let (index, _) = KernelIndex::open(&index_path).expect("open verifier index");
        let cancelled = AtomicBool::new(false);
        let candidates = vec!["a.txt".to_owned(), "b.txt".to_owned()];
        let scoped = index
            .query_literal_in_path("TOKEN(", Some("a.txt"), None)
            .expect("path-scoped literal query");
        assert_eq!(scoped.candidate_files, 1);
        assert_eq!(scoped.total_occurrences, 2);
        assert!(scoped.occurrences.iter().all(|value| value.path == "a.txt"));
        assert!(path_is_in_scope("scope/file.txt", Some("scope")));
        assert!(!path_is_in_scope("scope-other/file.txt", Some("scope")));

        let bounded = index
            .verify_regex_candidates("TOKEN\\(", &candidates, 1, 1, Some(1), &cancelled)
            .expect("bounded verification");
        assert_eq!(bounded.total_matches, 2);
        assert_eq!(bounded.verified_files, 2);
        assert!(bounded.truncated);
        assert_eq!(bounded.matches.len(), 1);
        assert_eq!(bounded.matches[0].path, "a.txt");
        assert_eq!(bounded.matches[0].line_number, 2);
        assert_eq!(bounded.matches[0].line_text, "TOKEN(one TOKEN(two");
        assert_eq!(bounded.matches[0].before, vec!["before"]);
        assert_eq!(bounded.matches[0].after, vec!["after"]);
        assert_eq!(bounded.matches[0].ranges.len(), 2);
        assert_eq!(bounded.matches[0].ranges[0].line_start, 0);
        assert_eq!(bounded.matches[0].ranges[0].line_end, 6);

        let literal = index
            .verify_literal_candidates("TOKEN(", false, &candidates, 1, 1, Some(1), &cancelled)
            .expect("bounded literal verification");
        assert_eq!(literal.total_matches, 2);
        assert_eq!(literal.total_occurrences, 3);
        assert_eq!(literal.indexed_occurrences, 3);
        assert_eq!(literal.verified_files, 2);
        assert!(literal.truncated);
        assert_eq!(literal.matches.len(), 1);
        assert_eq!(literal.matches[0].ranges.len(), 2);
        assert_eq!(literal.matches[0].before, vec!["before"]);
        assert_eq!(literal.matches[0].after, vec!["after"]);
        let chunk_literal = index
            .verify_literal_candidates(
                "TOKEN(",
                false,
                &["chunk.txt".into()],
                0,
                0,
                None,
                &cancelled,
            )
            .expect("chunk-boundary literal verification");
        assert_eq!(chunk_literal.total_occurrences, 1);
        assert_eq!(chunk_literal.matches[0].ranges[0].absolute_start, 65_535);

        assert!(matches!(
            index.verify_literal_candidates(
                "TOKEN(",
                false,
                &["b.txt".into(), "a.txt".into()],
                0,
                0,
                None,
                &cancelled,
            ),
            Err(KernelError::UnsupportedLiteral(_))
        ));
        let bom_literal = index
            .verify_literal_candidates("TOKEN(", false, &["bom.txt".into()], 0, 0, None, &cancelled)
            .expect("UTF-8 BOM literal verification");
        assert_eq!(bom_literal.total_occurrences, 1);
        assert_eq!(bom_literal.indexed_occurrences, 0);
        assert_eq!(bom_literal.matches[0].ranges[0].absolute_start, 0);

        let unlimited = index
            .verify_regex_candidates("TOKEN\\(", &candidates, 0, 0, None, &cancelled)
            .expect("unlimited verification");
        assert_eq!(unlimited.matches.len(), 2);
        assert_eq!(unlimited.total_matches, 2);
        assert!(!unlimited.truncated);
        let zero = index
            .verify_regex_candidates("TOKEN\\(", &candidates, 0, 0, Some(0), &cancelled)
            .expect("zero materialization verification");
        assert!(zero.matches.is_empty());
        assert_eq!(zero.total_matches, 2);
        assert!(zero.truncated);

        assert!(matches!(
            index.verify_regex_candidates("[", &candidates, 0, 0, None, &cancelled),
            Err(KernelError::UnsupportedRegex(_))
        ));
        assert!(matches!(
            index.verify_regex_candidates(
                "TOKEN\\(",
                &["b.txt".into(), "a.txt".into()],
                0,
                0,
                None,
                &cancelled,
            ),
            Err(KernelError::UnsupportedRegex(_))
        ));
        let bom = index
            .verify_regex_candidates("TOKEN\\(", &["bom.txt".into()], 0, 0, None, &cancelled)
            .expect("UTF-8 BOM verification");
        assert_eq!(bom.total_matches, 1);
        assert_eq!(bom.verified_files, 1);
        assert_eq!(bom.matches[0].line_text, "TOKEN(four");
        assert_eq!(bom.matches[0].ranges[0].absolute_start, 0);
        assert_eq!(bom.matches[0].ranges[0].line_start, 0);
        cancelled.store(true, Ordering::Relaxed);
        assert!(matches!(
            index.verify_regex_candidates("TOKEN\\(", &candidates, 0, 0, None, &cancelled),
            Err(KernelError::Aborted)
        ));
    }

    #[test]
    fn regex_candidates_keep_only_binary_prefixes_that_can_contain_a_match() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "after.bin", b"\0mandatory-token");
        write(directory.path(), "before.bin", b"mandatory-token\0tail");
        write(directory.path(), "boundary.bin", b"mandatory\0tail");
        let mut late = vec![b'x'; 100_000];
        late.push(0);
        late.extend_from_slice(b"mandatory-token");
        write(directory.path(), "late.bin", &late);
        write(directory.path(), "partial.bin", b"ma\0mandatory-token");
        write(directory.path(), "text.txt", b"mandatory-token\n");
        let paths = vec![
            "after.bin".to_owned(),
            "before.bin".to_owned(),
            "boundary.bin".to_owned(),
            "late.bin".to_owned(),
            "partial.bin".to_owned(),
            "text.txt".to_owned(),
        ];
        let v1_path = directory.path().join(".pi/index/v1.pfg");
        let v5_path = directory.path().join(".pi/index/v5.pfg");
        let v1 = build_index(directory.path(), &paths, &v1_path).expect("build v1");
        let v5 =
            build_index_with_source_digest(directory.path(), &paths, &v5_path).expect("build v5");
        assert_eq!(v1.format_version, FORMAT_VERSION_V1);
        assert_eq!(v5.stats.format_version, FORMAT_VERSION_V5);

        let expected_binary = vec!["before.bin".to_owned(), "boundary.bin".to_owned()];
        let expected_text = vec!["text.txt".to_owned()];
        for index_path in [&v1_path, &v5_path] {
            let (index, _) = KernelIndex::open(index_path).expect("open");
            let result = index
                .query_regex_candidates("mandatory(?:-token)?")
                .expect("query")
                .expect("planned");
            assert_eq!(result.candidate_files, 6);
            assert_eq!(result.candidate_paths, expected_text);
            assert_eq!(result.binary_candidate_paths, expected_binary);
        }
    }

    #[test]
    fn rejects_unsupported_literals_and_unsafe_paths() {
        let (directory, index_path, _) = build_fixture();
        for pattern in ["", "é", "a\nb", "a\0b"] {
            let empty_index = build_index(directory.path(), &[], &index_path).expect("empty build");
            assert_eq!(empty_index.files, 0);
            let (index, _) = KernelIndex::open(&index_path).expect("open empty");
            assert!(matches!(
                index.query_literal(pattern, None),
                Err(KernelError::UnsupportedLiteral(_))
            ));
        }
        for relative in [
            "../escape.txt",
            "/absolute.txt",
            "a//b.txt",
            "./a.txt",
            ".git/config",
            ".pi/index/self",
            ".fast-grep/cache",
            "windows\\path.txt",
            "line\nbreak.txt",
        ] {
            let result = build_index(directory.path(), &[relative.into()], &index_path);
            assert!(matches!(
                result,
                Err(KernelError::InvalidRelativePath { .. })
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_files_and_parent_symlink_escape() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        write(outside.path(), "outside.txt", b"needle");
        symlink(
            outside.path().join("outside.txt"),
            directory.path().join("link.txt"),
        )
        .expect("file symlink");
        symlink(outside.path(), directory.path().join("parent")).expect("parent symlink");
        let index_path = directory.path().join("index.pfg");
        for relative in ["link.txt", "parent/outside.txt"] {
            let result = build_index(directory.path(), &[relative.into()], &index_path);
            assert!(matches!(
                result,
                Err(KernelError::InvalidRelativePath { .. })
            ));
        }
    }

    #[test]
    fn rejects_truncated_and_corrupt_indexes() {
        let (directory, index_path, paths) = build_fixture();
        build_index(directory.path(), &paths, &index_path).expect("build");
        let original = fs::read(&index_path).expect("read index");

        fs::write(&index_path, &original[..original.len() - 1]).expect("truncate");
        assert!(matches!(
            KernelIndex::open(&index_path),
            Err(KernelError::Corrupt(_))
        ));

        let mut payload_corrupt = original.clone();
        let last = payload_corrupt.len() - 1;
        payload_corrupt[last] ^= 0xff;
        fs::write(&index_path, payload_corrupt).expect("corrupt payload");
        assert!(matches!(
            KernelIndex::open(&index_path),
            Err(KernelError::Corrupt(_))
        ));

        let mut header_corrupt = original;
        header_corrupt[16] ^= 1;
        fs::write(&index_path, header_corrupt).expect("corrupt header");
        assert!(matches!(
            KernelIndex::open(&index_path),
            Err(KernelError::Corrupt(_))
        ));
    }

    #[test]
    fn atomically_replaces_an_existing_generation() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "a.txt", b"old-token\n");
        let index_path = directory.path().join("index.pfg");
        build_index(directory.path(), &["a.txt".into()], &index_path).expect("first build");
        let old_mtime = fs::metadata(directory.path().join("a.txt"))
            .expect("metadata")
            .modified()
            .expect("mtime");
        write(directory.path(), "a.txt", b"new-token\n");
        set_file_mtime(
            directory.path().join("a.txt"),
            FileTime::from_system_time(old_mtime + Duration::from_secs(2)),
        )
        .expect("set mtime");
        build_index(directory.path(), &["a.txt".into()], &index_path).expect("second build");
        let (index, _) = KernelIndex::open(&index_path).expect("open");
        assert_eq!(
            index
                .query_literal("old-token", None)
                .expect("old")
                .total_occurrences,
            0
        );
        assert_eq!(
            index
                .query_literal("new-token", None)
                .expect("new")
                .total_occurrences,
            1
        );
    }

    #[test]
    fn malformed_payload_never_panics_during_open() {
        let (directory, index_path, paths) = build_fixture();
        build_index(directory.path(), &paths, &index_path).expect("build");
        let original = fs::read(&index_path).expect("read");
        for cut in [0, 1, 7, 8, 64, 135, 168, 255, 256, original.len() / 2] {
            fs::write(&index_path, &original[..cut.min(original.len())]).expect("write cut");
            let result = std::panic::catch_unwind(|| KernelIndex::open(&index_path));
            assert!(result.is_ok(), "cut={cut}");
            assert!(result.expect("no panic").is_err(), "cut={cut}");
        }
    }

    #[test]
    fn content_digest_catches_same_size_restored_mtime_changes() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "a.txt", b"alpha");
        let path = directory.path().join("a.txt");
        let before_digest = source_digest(directory.path(), &["a.txt"]);
        let before = source_snapshot(&path).expect("before");
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(false)
            .open(&path)
            .expect("open");
        file.seek(SeekFrom::Start(0)).expect("seek");
        file.write_all(b"omega").expect("write");
        file.sync_all().expect("sync");
        set_file_mtime(
            &path,
            FileTime::from_system_time(before.modified.expect("fixture mtime")),
        )
        .expect("restore mtime");
        let after = source_snapshot(&path).expect("after");
        let after_digest = source_digest(directory.path(), &["a.txt"]);
        assert_eq!(before, after, "fixture must collide on size and mtime");
        assert_ne!(
            before_digest.content_sha256, after_digest.content_sha256,
            "content digest must distinguish the metadata collision"
        );
    }

    #[cfg(unix)]
    #[test]
    fn isolated_trusted_digest_matches_strict_and_preserves_pre_open_gates() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        write(directory.path(), "empty.txt", b"");
        write(
            directory.path(),
            "src/large.txt",
            &vec![b'x'; SOURCE_DIGEST_BUFFER_LEN + 17],
        );
        write(directory.path(), "src/\u{e000}.txt", b"private");
        write(directory.path(), "src/\u{1f600}.txt", b"supplementary");
        write(
            directory.path(),
            "real-parent/inside.txt",
            b"inside symlink",
        );
        symlink("real-parent", directory.path().join("inside-parent"))
            .expect("in-root parent symlink");
        let paths = [
            "src/\u{1f600}.txt",
            "empty.txt",
            "src/large.txt",
            "src/\u{e000}.txt",
        ];
        assert_eq!(
            isolated_trusted_source_digest(directory.path(), &paths),
            source_digest(directory.path(), &paths),
        );
        assert_eq!(
            isolated_trusted_source_digest(directory.path(), &["inside-parent/inside.txt"]),
            source_digest(directory.path(), &["inside-parent/inside.txt"]),
            "a relative parent symlink that stays beneath root remains supported",
        );

        write(outside.path(), "secret.txt", b"outside");
        symlink(
            outside.path().join("secret.txt"),
            directory.path().join("leaf.txt"),
        )
        .expect("leaf symlink");
        symlink(outside.path(), directory.path().join("parent")).expect("parent symlink");
        let canonical_root = fs::canonicalize(directory.path()).expect("canonical root");
        for relative_path in ["leaf.txt", "parent/secret.txt"] {
            let mut digester =
                SourceContentDigester::new(directory.path(), &canonical_root).expect("digester");
            assert!(matches!(
                digester.add_isolated_trusted(relative_path),
                Err(KernelError::InvalidRelativePath { .. })
            ));
        }

        write(directory.path(), "race.txt", b"inside");
        let race_path = directory.path().join("race.txt");
        let race_displaced = directory.path().join("race-old.txt");
        let mut digester =
            SourceContentDigester::new(directory.path(), &canonical_root).expect("digester");
        let result = digester.add_isolated_trusted_with_phase_hook("race.txt", |phase, joined| {
            if phase == SourceDigestPhase::PathValidated {
                fs::rename(&race_path, &race_displaced).expect("displace validated leaf");
                symlink(outside.path().join("secret.txt"), joined).expect("install leaf symlink");
            }
            Ok(())
        });
        assert!(result.is_err(), "leaf retarget must fail before reading");

        write(directory.path(), "safe/file.txt", b"inside");
        write(outside.path(), "file.txt", b"outside");
        let safe_parent = directory.path().join("safe");
        let safe_displaced = directory.path().join("safe-old");
        let mut digester =
            SourceContentDigester::new(directory.path(), &canonical_root).expect("digester");
        let result = digester.add_isolated_trusted_with_phase_hook("safe/file.txt", |phase, _| {
            if phase == SourceDigestPhase::PathValidated {
                fs::rename(&safe_parent, &safe_displaced).expect("displace validated parent");
                symlink(outside.path(), &safe_parent).expect("install parent symlink");
            }
            Ok(())
        });
        assert!(
            matches!(
                result,
                Err(KernelError::InvalidRelativePath { .. } | KernelError::SourceChanged(_))
            ),
            "parent retarget must fail closed before reading"
        );
    }

    #[cfg(unix)]
    #[test]
    fn source_digest_rejects_symlink_escape_and_opened_path_replacement() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        write(outside.path(), "secret.txt", b"outside");
        symlink(
            outside.path().join("secret.txt"),
            directory.path().join("leaf.txt"),
        )
        .expect("leaf symlink");
        symlink(outside.path(), directory.path().join("parent")).expect("parent symlink");
        let canonical_root = fs::canonicalize(directory.path()).expect("canonical root");
        for relative_path in ["leaf.txt", "parent/secret.txt"] {
            let mut digester =
                SourceContentDigester::new(directory.path(), &canonical_root).expect("digester");
            assert!(matches!(
                digester.add(relative_path),
                Err(KernelError::InvalidRelativePath { .. })
            ));
        }

        write(directory.path(), "race.txt", b"inside");
        let race_path = directory.path().join("race.txt");
        let race_displaced = directory.path().join("race-old.txt");
        let mut raced_leaf = false;
        let mut digester =
            SourceContentDigester::new(directory.path(), &canonical_root).expect("digester");
        let result = digester.add_with_phase_hook("race.txt", |phase, joined| {
            if phase == SourceDigestPhase::PathValidated {
                fs::rename(&race_path, &race_displaced).expect("displace validated leaf");
                symlink(outside.path().join("secret.txt"), joined).expect("install leaf symlink");
                raced_leaf = true;
            }
            Ok(())
        });
        assert!(raced_leaf);
        assert!(
            result.is_err(),
            "validated leaf symlink race must fail closed"
        );

        write(directory.path(), "safe/file.txt", b"inside");
        write(outside.path(), "file.txt", b"outside");
        let safe_parent = directory.path().join("safe");
        let safe_displaced = directory.path().join("safe-old");
        let mut raced_parent = false;
        let mut digester =
            SourceContentDigester::new(directory.path(), &canonical_root).expect("digester");
        let result = digester.add_with_phase_hook("safe/file.txt", |phase, _| {
            if phase == SourceDigestPhase::PathValidated {
                fs::rename(&safe_parent, &safe_displaced).expect("displace validated parent");
                symlink(outside.path(), &safe_parent).expect("install parent symlink");
                raced_parent = true;
            }
            Ok(())
        });
        assert!(raced_parent);
        assert!(
            matches!(result, Err(KernelError::SourceChanged(path)) if path == "safe/file.txt"),
            "parent retarget must fail the opened inode identity gate"
        );

        let original_bytes = vec![b'a'; SOURCE_DIGEST_BUFFER_LEN * 2 + 17];
        let replacement_bytes = vec![b'b'; original_bytes.len()];
        write(directory.path(), "a.txt", &original_bytes);
        write(directory.path(), "replacement.txt", &replacement_bytes);
        let original = directory.path().join("a.txt");
        let displaced = directory.path().join("a-old.txt");
        let replacement = directory.path().join("replacement.txt");
        let mut replaced = false;
        let mut digester =
            SourceContentDigester::new(directory.path(), canonical_root).expect("digester");
        let result = digester.add_with_phase_hook("a.txt", |phase, _| {
            if phase == SourceDigestPhase::FirstChunk {
                fs::rename(&original, &displaced).expect("displace opened path");
                fs::rename(&replacement, &original).expect("install replacement");
                replaced = true;
            }
            Ok(())
        });
        assert!(replaced);
        assert!(matches!(result, Err(KernelError::SourceChanged(path)) if path == "a.txt"));
        assert_eq!(
            fs::read(original).expect("read replacement"),
            replacement_bytes
        );
    }

    #[cfg(unix)]
    #[test]
    fn source_digest_rejects_same_inode_rewrite_after_read() {
        let directory = tempfile::tempdir().expect("tempdir");
        write(directory.path(), "a.txt", b"alpha");
        let path = directory.path().join("a.txt");
        let before = source_snapshot(&path).expect("before");
        let before_metadata = fs::metadata(&path).expect("before metadata");
        let before_mtime = FileTime::from_last_modification_time(&before_metadata);
        let canonical_root = fs::canonicalize(directory.path()).expect("canonical root");
        let mut rewrote = false;
        let mut digester =
            SourceContentDigester::new(directory.path(), canonical_root).expect("digester");
        let result = digester.add_with_phase_hook("a.txt", |phase, joined| {
            if phase == SourceDigestPhase::ReadComplete {
                let mut file = OpenOptions::new()
                    .write(true)
                    .truncate(false)
                    .open(joined)
                    .expect("open rewrite");
                file.seek(SeekFrom::Start(0)).expect("seek rewrite");
                file.write_all(b"omega").expect("rewrite");
                file.sync_all().expect("sync rewrite");
                set_file_mtime(joined, before_mtime).expect("restore mtime");
                rewrote = true;
            }
            Ok(())
        });
        assert!(rewrote);
        assert_eq!(
            before,
            source_snapshot(&path).expect("after"),
            "fixture must restore the old length and mtime"
        );
        assert!(matches!(result, Err(KernelError::SourceChanged(changed)) if changed == "a.txt"));
    }
}
