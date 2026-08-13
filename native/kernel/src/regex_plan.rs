use std::collections::BTreeSet;

use regex_syntax::{
    ParserBuilder,
    hir::{Hir, HirKind},
};

use crate::pack_gram;

const REGEX_NEST_LIMIT: u32 = 250;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RegexPlanError {
    InvalidRegex,
}

/// Return every raw-byte trigram that structural induction proves occurs in
/// every match of `pattern`.
///
/// The parser configuration mirrors ripgrep 15.1's default Rust-regex matcher.
/// A parse error is deliberately distinct from an empty proof: both route to
/// full ripgrep, but an error must never be mistaken for an empty result.
pub(crate) fn mandatory_trigrams(
    pattern: &str,
    ignore_case: bool,
) -> Result<BTreeSet<u32>, RegexPlanError> {
    let mut parser = ParserBuilder::new();
    parser
        .nest_limit(REGEX_NEST_LIMIT)
        .octal(false)
        .utf8(false)
        .ignore_whitespace(false)
        .case_insensitive(ignore_case)
        .multi_line(true)
        .dot_matches_new_line(false)
        .crlf(false)
        .swap_greed(false)
        .unicode(true);
    let hir = parser
        .build()
        .parse(pattern)
        .map_err(|_| RegexPlanError::InvalidRegex)?;
    Ok(mandatory_hir_trigrams(&hir))
}

fn mandatory_hir_trigrams(hir: &Hir) -> BTreeSet<u32> {
    match hir.kind() {
        HirKind::Literal(literal) => literal.0.windows(3).map(pack_gram).collect(),
        HirKind::Capture(capture) => mandatory_hir_trigrams(&capture.sub),
        HirKind::Repetition(repetition) if repetition.min > 0 => {
            mandatory_hir_trigrams(&repetition.sub)
        }
        HirKind::Concat(expressions) => {
            let mut grams = BTreeSet::new();
            for expression in expressions {
                grams.extend(mandatory_hir_trigrams(expression));
            }
            grams
        }
        HirKind::Alternation(expressions) => {
            let mut expressions = expressions.iter();
            let Some(first) = expressions.next() else {
                return BTreeSet::new();
            };
            let mut grams = mandatory_hir_trigrams(first);
            for expression in expressions {
                let branch = mandatory_hir_trigrams(expression);
                grams.retain(|gram| branch.contains(gram));
                if grams.is_empty() {
                    break;
                }
            }
            grams
        }
        HirKind::Empty | HirKind::Class(_) | HirKind::Look(_) | HirKind::Repetition(_) => {
            BTreeSet::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packed(value: [u8; 3]) -> u32 {
        pack_gram(&value)
    }

    fn grams(pattern: &str) -> BTreeSet<u32> {
        mandatory_trigrams(pattern, false).expect("valid regex")
    }

    #[test]
    fn literal_capture_repetition_and_concat_preserve_mandatory_grams() {
        assert_eq!(
            grams("abcdef"),
            [
                packed(*b"abc"),
                packed(*b"bcd"),
                packed(*b"cde"),
                packed(*b"def")
            ]
            .into_iter()
            .collect(),
        );
        assert_eq!(grams(r"(?P<name>needle)"), grams("needle"));
        assert_eq!(grams("(?:needle)+"), grams("needle"));
        assert!(grams("(?:needle)?").is_empty());
        assert!(grams("(?:needle)*").is_empty());

        let concat = grams(r"\bfoo.*bar\b");
        assert!(concat.contains(&packed(*b"foo")));
        assert!(concat.contains(&packed(*b"bar")));
    }

    #[test]
    fn alternation_keeps_only_grams_required_by_every_branch() {
        let common = grams("foobar|foobaz");
        assert!(common.contains(&packed(*b"foo")));
        assert!(common.contains(&packed(*b"oob")));
        assert!(common.contains(&packed(*b"oba")));
        assert!(!common.contains(&packed(*b"bar")));
        assert!(!common.contains(&packed(*b"baz")));
        assert!(grams("foo|bar").is_empty());
        assert!(grams("(?:spin|read|write)_[a-z_]{4,20}").is_empty());
    }

    #[test]
    fn visible_complex_regexes_have_only_structurally_proven_grams() {
        for pattern in [
            r"CONFIG_[A-Z][A-Z0-9_]+",
            r"\bdo_sys_openat2\b",
            r"(?P<export>EXPORT_SYMBOL(?:_GPL)?)",
            r"\p{Lu}{4,}_GPL",
            r"(?x) CONFIG_ [A-Z0-9_]+",
            r"do_sys_.*at2",
            r"^export (?:const|function) [A-Za-z_][A-Za-z0-9_]*",
        ] {
            assert!(!grams(pattern).is_empty(), "{pattern}");
        }
        assert!(!grams("IConfigurationService|IInstantiationService").is_empty());
        assert!(!grams("NewSharedInformerFactory|NewForConfig").is_empty());
        assert!(grams("(struct|enum) [a-z_]+").is_empty());
    }

    #[test]
    fn flags_and_raw_byte_literals_remain_conservative() {
        assert!(
            mandatory_trigrams("(?i)Needle", false)
                .expect("case folded regex")
                .is_empty()
        );
        assert!(
            mandatory_trigrams("Needle", true)
                .expect("external case folding")
                .is_empty()
        );
        assert!(grams(r"(?i:needle)(?-i:BAR)").contains(&packed(*b"BAR")));
        assert!(grams(r"(?-u:\xFF)foo").contains(&packed(*b"foo")));
        assert!(grams("é").is_empty());
        assert!(!grams("€").is_empty());
    }

    #[test]
    fn invalid_rust_regexes_remain_parse_errors() {
        for pattern in [r"(?<=FAST_GREP_)PROBE", r"(FAST_GREP)_\1"] {
            assert!(mandatory_trigrams(pattern, false).is_err(), "{pattern}");
        }
    }
}
