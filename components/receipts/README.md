# Research receipts

Ruby combines a Go depth replay and Java calibration summary into a content-addressed record. It validates an exact public summary schema and rejects unknown fields. The SHA-256 ID covers the normalized JSON body. The same summaries produce the same ID regardless of key order or input file name.

```sh
ruby receipt.rb create --depth depth.json --calibration calibration.json
ruby receipt.rb create --depth depth.json --calibration calibration.json --format markdown
```

For optional MongoDB archiving, install the locked gems with `bundle install` and supply `PREDICTIR_RECEIPTS_MONGODB_URI` through your secret manager or process environment. Use an encrypted connection for remote databases. The driver uses the `predictir_research.run_receipts` collection, where MongoDB's unique `_id` is the receipt digest.

```sh
bundle exec ruby receipt.rb create --depth depth.json --calibration calibration.json --archive
bundle exec ruby receipt.rb get <receipt-sha256>
```

A repeated write returns the existing receipt after verifying its digest. Each read verifies both the public schema and the stored digest. PostgreSQL owns live market state, portfolios, and application accounts. This archive stores only normalized research summaries.

Run `ruby receipt_test.rb` for local checks. Set `PREDICTIR_RECEIPTS_TEST_MONGODB_URI` to a disposable local MongoDB 8.0 instance and run `bundle exec ruby receipt_test.rb` for the repeat-write and tamper checks.
