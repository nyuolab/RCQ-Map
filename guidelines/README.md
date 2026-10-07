# Annotation guidelines

`annotation_guidelines.txt` is the RCQ-Map guideline text, reproduced byte for byte from the paper's runs and printed
as Supplementary Note 1. Clinicians saw this exact text on the annotation platform and the model received it as its
instructions; the two were checked to be identical before every run. Its first line still carries the working title
and number the document had during development. It is left unchanged so that the checksum in `SHA256SUMS` holds.

`rcqmap verify` checks the copy bundled in the package. If you adapt the guidelines (for example, the
clinical-department ladder follows the paper's institution), save them under a new name and say so when you report
results: labels from modified guidelines are not comparable with the paper's.

License: CC BY 4.0.
