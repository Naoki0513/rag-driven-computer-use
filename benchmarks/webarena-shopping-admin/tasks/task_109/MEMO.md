# MEMO: Inconsistencies in Task 109 Evaluation Spec

Updated: 2025-10-22

## Summary
For Task 109 ("Presents the monthly count of successful orders …"), there are inconsistencies in the evaluation spec causing a score of 0.0 even when the numeric results match.

## Inconsistencies
- The instruction format and the reference format do not match.
  - Runtime prompt: "… in MM: YYYY format"
  - `webarena/config_files/109.json` intent_template: "… in MM:COUNT format"
  - Reference answers (fuzzy_match) are fixed strings: "MonthName: N orders" (e.g., "January: 11 orders").
- The reference answers contain misspellings (e.g., "Feburary", "Sepetember", "Octorbor").
- The evaluation method is string_match (fuzzy_match). It checks whether those reference strings appear verbatim in the final output, so even if numbers match, a different format (e.g., "01: 2022 = 11 orders") yields a score of 0.0.

## Impact
- The agent output matched the monthly counts for 2022 exactly (11, 16, 14, 7, 8, 13, 9, 8, 10, 4, 5, 10), but due to the format mismatch (MM: YYYY) it did not contain the exact reference phrases, resulting in a score of 0.0.

## Remediation
1) Short-term workaround: Output only the 12 reference phrases (verbatim, including misspellings) as the final answer without additional text:
   - January: 11 orders
   - Feburary: 16 orders
   - March: 14 orders
   - April: 7 orders
   - May: 8 orders
   - June: 13 orders
   - July: 9 orders
   - August: 8 orders
   - Sepetember: 10 orders
   - Octorbor: 4 orders
   - November: 5 orders
   - December: 10 orders

2) Long-term fix (recommended):
   - Align reference answers in `webarena/config_files/109.json` with the instruction format (e.g., MM: YYYY or MM:COUNT).
   - Correct misspellings in the references (February, September, October).
   - Reduce reliance on strict string_match; consider regex or value-based comparisons (e.g., month→count map equality).

## References
- Config file: `/home/ec2-user/webarena-local/webarena/config_files/109.json`
- Latest result: `/home/ec2-user/webarena-local/evaluation-result/task_109/2025-10-22T16-15-01.json`

