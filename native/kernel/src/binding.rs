use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Instant;

use napi::{
    Env, Error, Status, Task,
    bindgen_prelude::{Array, AsyncTask},
};
use napi_derive::napi;

use crate::{
    BuildStats, BuildWithSourceDigest, KernelError, KernelIndex, LiteralVerifyResult, OpenStats,
    QueryResult, RegexCandidateResult, RegexVerifyResult, SourceContentDigester, VerifiedMatch,
    VerifiedRange, build_index as build_core_index,
    build_index_with_source_digest as build_core_index_with_source_digest,
};

#[napi]
pub const BINDING_ABI_VERSION: u32 = 10;

#[napi]
pub fn binding_target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[napi(object, object_from_js = false)]
pub struct JsBuildStats {
    pub format_version: u32,
    pub files: u64,
    pub binary_files: u64,
    pub grams: u64,
    pub postings: u64,
    pub index_bytes: u64,
    pub build_duration_ns: u128,
}

impl From<BuildStats> for JsBuildStats {
    fn from(value: BuildStats) -> Self {
        Self {
            format_version: value.format_version,
            files: value.files,
            binary_files: value.binary_files,
            grams: value.grams,
            postings: value.postings,
            index_bytes: value.index_bytes,
            build_duration_ns: value.build_duration.as_nanos(),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsBuildWithSourceDigestStats {
    pub format_version: u32,
    pub files: u64,
    pub binary_files: u64,
    pub grams: u64,
    pub postings: u64,
    pub index_bytes: u64,
    pub content_sha256: String,
    pub source_bytes: u64,
    pub build_duration_ns: u128,
}

impl From<BuildWithSourceDigest> for JsBuildWithSourceDigestStats {
    fn from(value: BuildWithSourceDigest) -> Self {
        let stats = value.stats;
        Self {
            format_version: stats.format_version,
            files: stats.files,
            binary_files: stats.binary_files,
            grams: stats.grams,
            postings: stats.postings,
            index_bytes: stats.index_bytes,
            content_sha256: value.content_sha256,
            source_bytes: value.source_bytes,
            build_duration_ns: stats.build_duration.as_nanos(),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsOpenStats {
    pub format_version: u32,
    pub files: u64,
    pub binary_files: u64,
    pub grams: u64,
    pub postings: u64,
    pub index_bytes: u64,
    pub open_duration_ns: u128,
}

#[napi(object, object_from_js = false)]
pub struct JsSourceContentDigest {
    pub content_sha256: String,
    pub files: u64,
    pub source_bytes: u64,
    pub duration_ns: u128,
}

impl From<OpenStats> for JsOpenStats {
    fn from(value: OpenStats) -> Self {
        Self {
            format_version: value.format_version,
            files: value.files,
            binary_files: value.binary_files,
            grams: value.grams,
            postings: value.postings,
            index_bytes: value.index_bytes,
            open_duration_ns: value.open_duration.as_nanos(),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsOccurrence {
    pub path: String,
    pub absolute_start: u64,
    pub absolute_end: u64,
}

#[napi(object, object_from_js = false)]
pub struct JsQueryResult {
    pub occurrences: Vec<JsOccurrence>,
    pub total_occurrences: u64,
    pub candidate_files: u64,
    pub binary_match_files: Vec<String>,
    pub utf8_bom_candidate_files: Vec<String>,
    pub transcoded_candidate_files: Vec<String>,
    pub unsafe_transcoded_files: Vec<String>,
    pub unsafe_case_fold_files: Vec<String>,
    pub requires_fallback: bool,
    pub query_duration_ns: u128,
}

impl From<QueryResult> for JsQueryResult {
    fn from(value: QueryResult) -> Self {
        Self {
            occurrences: value
                .occurrences
                .into_iter()
                .map(|occurrence| JsOccurrence {
                    path: occurrence.path,
                    absolute_start: occurrence.absolute_start,
                    absolute_end: occurrence.absolute_end,
                })
                .collect(),
            total_occurrences: value.total_occurrences,
            candidate_files: value.candidate_files,
            binary_match_files: value.binary_match_files,
            utf8_bom_candidate_files: value.utf8_bom_candidate_files,
            transcoded_candidate_files: value.transcoded_candidate_files,
            unsafe_transcoded_files: value.unsafe_transcoded_files,
            unsafe_case_fold_files: value.unsafe_case_fold_files,
            requires_fallback: value.requires_fallback,
            query_duration_ns: value.query_duration.as_nanos(),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsRegexCandidateResult {
    pub selected_gram: u32,
    pub mandatory_grams: u64,
    pub candidate_paths: Vec<String>,
    pub candidate_files: u64,
    /// Ordinary binary candidates whose pre-NUL bytes still contain the
    /// selected mandatory trigram and therefore require full-tree ripgrep.
    pub binary_candidate_paths: Vec<String>,
    pub utf8_bom_candidate_paths: Vec<String>,
    pub transcoded_candidate_paths: Vec<String>,
    pub unsafe_transcoded_paths: Vec<String>,
    pub complete: bool,
    pub query_duration_ns: u128,
}

impl From<RegexCandidateResult> for JsRegexCandidateResult {
    fn from(value: RegexCandidateResult) -> Self {
        Self {
            selected_gram: value.selected_gram,
            mandatory_grams: value.mandatory_grams,
            candidate_paths: value.candidate_paths,
            candidate_files: value.candidate_files,
            binary_candidate_paths: value.binary_candidate_paths,
            utf8_bom_candidate_paths: value.utf8_bom_candidate_paths,
            transcoded_candidate_paths: value.transcoded_candidate_paths,
            unsafe_transcoded_paths: value.unsafe_transcoded_paths,
            complete: true,
            query_duration_ns: value.query_duration.as_nanos(),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsVerifiedRange {
    pub absolute_start: u64,
    pub absolute_end: u64,
    pub line_start: u64,
    pub line_end: u64,
}

impl From<VerifiedRange> for JsVerifiedRange {
    fn from(value: VerifiedRange) -> Self {
        Self {
            absolute_start: value.absolute_start,
            absolute_end: value.absolute_end,
            line_start: value.line_start,
            line_end: value.line_end,
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsVerifiedMatch {
    pub path: String,
    pub line_number: u64,
    pub line_text: String,
    pub ranges: Vec<JsVerifiedRange>,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

impl From<VerifiedMatch> for JsVerifiedMatch {
    fn from(value: VerifiedMatch) -> Self {
        Self {
            path: value.path,
            line_number: value.line_number,
            line_text: value.line_text,
            ranges: value
                .ranges
                .into_iter()
                .map(JsVerifiedRange::from)
                .collect(),
            before: value.before,
            after: value.after,
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsRegexVerifyResult {
    pub matches: Vec<JsVerifiedMatch>,
    pub total_matches: u64,
    pub verified_files: u64,
    pub truncated: bool,
    pub query_duration_ns: u128,
}

#[napi(object, object_from_js = false)]
pub struct JsLiteralVerifyResult {
    pub matches: Vec<JsVerifiedMatch>,
    pub total_matches: u64,
    pub total_occurrences: u64,
    pub indexed_occurrences: u64,
    pub verified_files: u64,
    pub truncated: bool,
    pub query_duration_ns: u128,
}

impl From<LiteralVerifyResult> for JsLiteralVerifyResult {
    fn from(value: LiteralVerifyResult) -> Self {
        Self {
            matches: value
                .matches
                .into_iter()
                .map(JsVerifiedMatch::from)
                .collect(),
            total_matches: value.total_matches,
            total_occurrences: value.total_occurrences,
            indexed_occurrences: value.indexed_occurrences,
            verified_files: value.verified_files,
            truncated: value.truncated,
            query_duration_ns: value.query_duration.as_nanos(),
        }
    }
}

impl From<RegexVerifyResult> for JsRegexVerifyResult {
    fn from(value: RegexVerifyResult) -> Self {
        Self {
            matches: value
                .matches
                .into_iter()
                .map(JsVerifiedMatch::from)
                .collect(),
            total_matches: value.total_matches,
            verified_files: value.verified_files,
            truncated: value.truncated,
            query_duration_ns: value.query_duration.as_nanos(),
        }
    }
}

pub struct LiteralVerifyTask {
    index: Arc<KernelIndex>,
    literal: String,
    ignore_ascii_case: bool,
    candidate_paths: Vec<String>,
    before_count: usize,
    after_count: usize,
    match_limit: Option<usize>,
    cancelled: Arc<AtomicBool>,
    job_id: u32,
    jobs: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
    active_jobs: Arc<AtomicUsize>,
}

impl Task for LiteralVerifyTask {
    type Output = LiteralVerifyResult;
    type JsValue = JsLiteralVerifyResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.index
            .verify_literal_candidates(
                &self.literal,
                self.ignore_ascii_case,
                &self.candidate_paths,
                self.before_count,
                self.after_count,
                self.match_limit,
                &self.cancelled,
            )
            .map_err(|error| kernel_error(&error))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}

impl Drop for LiteralVerifyTask {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&self.job_id);
        }
        self.active_jobs.fetch_sub(1, Ordering::Relaxed);
    }
}

pub struct RegexVerifyTask {
    index: Arc<KernelIndex>,
    pattern: String,
    candidate_paths: Vec<String>,
    before_count: usize,
    after_count: usize,
    match_limit: Option<usize>,
    cancelled: Arc<AtomicBool>,
    job_id: u32,
    jobs: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
    active_jobs: Arc<AtomicUsize>,
}

impl Task for RegexVerifyTask {
    type Output = RegexVerifyResult;
    type JsValue = JsRegexVerifyResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.index
            .verify_regex_candidates(
                &self.pattern,
                &self.candidate_paths,
                self.before_count,
                self.after_count,
                self.match_limit,
                &self.cancelled,
            )
            .map_err(|error| kernel_error(&error))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}

impl Drop for RegexVerifyTask {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&self.job_id);
        }
        self.active_jobs.fetch_sub(1, Ordering::Relaxed);
    }
}

fn kernel_error(error: &KernelError) -> Error {
    let code = match error {
        KernelError::UnsupportedLiteral(_) => "PFG_UNSUPPORTED_LITERAL",
        KernelError::UnsupportedRegex(_) => "PFG_UNSUPPORTED_REGEX",
        KernelError::Aborted => "PFG_ABORTED",
        KernelError::InvalidRelativePath { .. } => "PFG_INVALID_RELATIVE_PATH",
        KernelError::SourceChanged(_) => "PFG_SOURCE_CHANGED",
        KernelError::Corrupt(_) => "PFG_CORRUPT_INDEX",
        KernelError::TooLarge => "PFG_TOO_LARGE",
        KernelError::UnsupportedPlatform(_) => "PFG_UNSUPPORTED_PLATFORM",
        KernelError::Io { .. } => "PFG_IO",
    };
    Error::new(Status::GenericFailure, format!("[{code}] {error}"))
}

fn closed_error() -> Error {
    Error::new(
        Status::GenericFailure,
        "[PFG_CLOSED] kernel index handle is closed".to_owned(),
    )
}

/// Synchronous only for the opt-in Round 0.19 binding proof. The product
/// manager will schedule cold builds away from Pi's event loop.
#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn build_kernel_index(
    root: String,
    relative_paths: Vec<String>,
    index_path: String,
) -> napi::Result<JsBuildStats> {
    build_core_index(root, &relative_paths, index_path)
        .map(JsBuildStats::from)
        .map_err(|error| kernel_error(&error))
}

/// Trusted cold-build seam: the caller guarantees that no unmarked writer can
/// run during this synchronous call. Byte-sorted inputs use beneath-root
/// descriptor capture plus the content-first format-v2 layout so the same
/// buffer produces the digest, postings, and persisted bytes; other inputs
/// retain the strict two-pass format-v1 layout.
#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn build_kernel_index_with_source_digest(
    root: String,
    relative_paths: Vec<String>,
    index_path: String,
) -> napi::Result<JsBuildWithSourceDigestStats> {
    build_core_index_with_source_digest(root, &relative_paths, index_path)
        .map(JsBuildWithSourceDigestStats::from)
        .map_err(|error| kernel_error(&error))
}

/// Synchronous only for the explicit isolated Agent-loop start contract. It
/// reads one JS path at a time and reuses one 64 KiB native buffer, avoiding a
/// second all-path Rust allocation and high-cardinality libuv request churn.
#[napi(js_name = "hashSourceContents")]
#[allow(clippy::needless_pass_by_value)]
pub fn hash_source_contents(
    root: String,
    canonical_root: String,
    #[napi(ts_arg_type = "ReadonlyArray<string>")] relative_paths: Array<'_>,
) -> napi::Result<JsSourceContentDigest> {
    let started = Instant::now();
    let mut digester =
        SourceContentDigester::new(root, canonical_root).map_err(|error| kernel_error(&error))?;
    for index in 0..relative_paths.len() {
        let relative_path = relative_paths.get::<String>(index)?.ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("relativePaths[{index}] is missing"),
            )
        })?;
        digester
            .add_isolated_trusted(&relative_path)
            .map_err(|error| kernel_error(&error))?;
    }
    let digest = digester.finish().map_err(|error| kernel_error(&error))?;
    Ok(JsSourceContentDigest {
        content_sha256: digest.content_sha256,
        files: digest.files,
        source_bytes: digest.source_bytes,
        duration_ns: started.elapsed().as_nanos(),
    })
}

#[napi(js_name = "KernelIndex")]
pub struct JsKernelIndex {
    inner: Option<Arc<KernelIndex>>,
    open_stats: JsOpenStats,
    jobs: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
    active_jobs: Arc<AtomicUsize>,
}

#[napi]
impl JsKernelIndex {
    #[napi(factory)]
    pub fn open(index_path: String) -> napi::Result<Self> {
        let (inner, stats) = KernelIndex::open(index_path).map_err(|error| kernel_error(&error))?;
        Ok(Self {
            inner: Some(Arc::new(inner)),
            open_stats: stats.into(),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            active_jobs: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// This intentionally has no limit parameter. The core must emit every
    /// occurrence; the TypeScript product layer applies its matching-line limit
    /// only after line aggregation and JS-compatible path ordering.
    #[napi]
    #[allow(clippy::needless_pass_by_value)]
    pub fn query_literal(
        &self,
        literal: String,
        path_root: Option<String>,
        glob_pattern: Option<String>,
        ignore_ascii_case: Option<bool>,
    ) -> napi::Result<JsQueryResult> {
        self.inner
            .as_ref()
            .ok_or_else(closed_error)?
            .query_literal_with_filters(
                &literal,
                path_root.as_deref(),
                glob_pattern.as_deref(),
                ignore_ascii_case.unwrap_or(false),
                None,
            )
            .map(JsQueryResult::from)
            .map_err(|error| kernel_error(&error))
    }

    /// Return one path per file in a structurally proven mandatory-trigram
    /// posting. The TypeScript layer must run the original regex over these
    /// candidates before returning any match.
    #[napi]
    #[allow(clippy::needless_pass_by_value)]
    pub fn query_regex_candidates(
        &self,
        pattern: String,
    ) -> napi::Result<Option<JsRegexCandidateResult>> {
        self.inner
            .as_ref()
            .ok_or_else(closed_error)?
            .query_regex_candidates(&pattern)
            .map(|result| result.map(JsRegexCandidateResult::from))
            .map_err(|error| kernel_error(&error))
    }

    #[napi(ts_return_type = "Promise<JsLiteralVerifyResult>")]
    #[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)]
    pub fn verify_literal_candidates(
        &self,
        literal: String,
        candidate_paths: Vec<String>,
        before_count: u32,
        after_count: u32,
        job_id: u32,
        match_limit: Option<u32>,
        ignore_ascii_case: Option<bool>,
    ) -> napi::Result<AsyncTask<LiteralVerifyTask>> {
        let index = Arc::clone(self.inner.as_ref().ok_or_else(closed_error)?);
        let before_count = usize::try_from(before_count).map_err(|_| {
            Error::new(
                Status::InvalidArg,
                "beforeCount does not fit usize".to_owned(),
            )
        })?;
        let after_count = usize::try_from(after_count).map_err(|_| {
            Error::new(
                Status::InvalidArg,
                "afterCount does not fit usize".to_owned(),
            )
        })?;
        let match_limit = match_limit.map(usize::try_from).transpose().map_err(|_| {
            Error::new(
                Status::InvalidArg,
                "matchLimit does not fit usize".to_owned(),
            )
        })?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock().map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "verification job registry is poisoned",
                )
            })?;
            match jobs.entry(job_id) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(Arc::clone(&cancelled));
                }
                std::collections::hash_map::Entry::Occupied(_) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!("verification job ID {job_id} is already active"),
                    ));
                }
            }
        }
        self.active_jobs.fetch_add(1, Ordering::Relaxed);
        Ok(AsyncTask::new(LiteralVerifyTask {
            index,
            literal,
            ignore_ascii_case: ignore_ascii_case.unwrap_or(false),
            candidate_paths,
            before_count,
            after_count,
            match_limit,
            cancelled,
            job_id,
            jobs: Arc::clone(&self.jobs),
            active_jobs: Arc::clone(&self.active_jobs),
        }))
    }

    #[napi(ts_return_type = "Promise<JsRegexVerifyResult>")]
    #[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)]
    pub fn verify_regex_candidates(
        &self,
        pattern: String,
        candidate_paths: Vec<String>,
        before_count: u32,
        after_count: u32,
        job_id: u32,
        match_limit: Option<u32>,
    ) -> napi::Result<AsyncTask<RegexVerifyTask>> {
        let index = Arc::clone(self.inner.as_ref().ok_or_else(closed_error)?);
        let before_count = usize::try_from(before_count).map_err(|_| {
            Error::new(
                Status::InvalidArg,
                "beforeCount does not fit usize".to_owned(),
            )
        })?;
        let after_count = usize::try_from(after_count).map_err(|_| {
            Error::new(
                Status::InvalidArg,
                "afterCount does not fit usize".to_owned(),
            )
        })?;
        let match_limit = match_limit.map(usize::try_from).transpose().map_err(|_| {
            Error::new(
                Status::InvalidArg,
                "matchLimit does not fit usize".to_owned(),
            )
        })?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock().map_err(|_| {
                Error::new(Status::GenericFailure, "regex job registry is poisoned")
            })?;
            match jobs.entry(job_id) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(Arc::clone(&cancelled));
                }
                std::collections::hash_map::Entry::Occupied(_) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!("regex job ID {job_id} is already active"),
                    ));
                }
            }
        }
        self.active_jobs.fetch_add(1, Ordering::Relaxed);
        let task = RegexVerifyTask {
            index,
            pattern,
            candidate_paths,
            before_count,
            after_count,
            match_limit,
            cancelled,
            job_id,
            jobs: Arc::clone(&self.jobs),
            active_jobs: Arc::clone(&self.active_jobs),
        };
        Ok(AsyncTask::new(task))
    }

    #[napi]
    pub fn cancel_regex_verification(&self, job_id: u32) -> napi::Result<bool> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "regex job registry is poisoned"))?;
        let Some(cancelled) = jobs.get(&job_id) else {
            return Ok(false);
        };
        cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    }

    #[napi]
    pub fn close(&mut self) -> bool {
        if let Ok(jobs) = self.jobs.lock() {
            for cancelled in jobs.values() {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
        self.inner.take().is_some()
    }

    #[napi(getter)]
    pub fn active_jobs(&self) -> u32 {
        u32::try_from(self.active_jobs.load(Ordering::Relaxed)).unwrap_or(u32::MAX)
    }

    #[napi(getter)]
    pub fn closed(&self) -> bool {
        self.inner.is_none()
    }

    #[napi(getter)]
    pub fn open_stats(&self) -> JsOpenStats {
        JsOpenStats {
            format_version: self.open_stats.format_version,
            files: self.open_stats.files,
            binary_files: self.open_stats.binary_files,
            grams: self.open_stats.grams,
            postings: self.open_stats.postings,
            index_bytes: self.open_stats.index_bytes,
            open_duration_ns: self.open_stats.open_duration_ns,
        }
    }
}
