# Changelog

## 1.0.0

First public release: the version used for every label in the paper.

- Annotation guidelines, byte-identical to the paper's runs (sha256 f8f0fc98778ed0398e76b83c6c843d0088391154045d80602500f9619fcb5394). The file's first line still carries the working title and number it had during development; it is kept unchanged so that the checksum holds.
- Output schema: 24 fields, three hard consistency rules.
- `rcqmap` annotator (OpenAI Responses, Claude, OpenAI-compatible servers), `derive` for the 20 reported fields, `compare` against the paper's real clinical queries, `bundle` for the annotation platform, `verify` for checksums.
- Clinician validation kit and blinded annotation platform.
