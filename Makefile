run:
	pnpm dev

build:
	pnpm build

test:
	pnpm test

process-once:
	@if [ -z "$(URL)" ]; then echo "usage: make process-once URL=https://youtu.be/... SPEAKER='Name'"; exit 1; fi
	pnpm process-once "$(URL)" --speaker "$(SPEAKER)"
