# Compatibility checks

When extending provider support, preserve every existing caller-selected model
profile and its workload controls. Replay provider responses through the next
real adapter request in tests, including opaque reasoning and assistant phase.
Keep stateless chat requests stateless; a profile resolving or a single mocked
response succeeding does not prove multi-turn compatibility or live quality.

Keep this package independent of its consumers. Define tests from the public
package API and provider contracts, using generic fixtures. Application names,
business workflows, rollout policy and application benchmarks belong in the
consuming repository, not in package tests or release notes.
