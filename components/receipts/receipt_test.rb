require "stringio"
require "tmpdir"
require_relative "receipt"

def assert(condition, label)
  raise label unless condition
end

def rejects(label)
  yield
rescue PredictirReceipts::Invalid
  return
else
  raise label
end

def depth_fixture
  {
    "schema" => PredictirReceipts::DEPTH_SCHEMA, "quote_count" => 3,
    "markets" => [
      { "ticker" => "KXRECEIPTTEST-B", "observations" => 1,
        "first_observed_at" => "2026-11-05T10:00:00Z", "latest_observed_at" => "2026-11-05T10:00:00.000Z",
        "first_midpoint" => 0.25, "latest_midpoint" => 0.25, "latest_spread" => 0.1, "midpoint_change" => 0 },
      { "ticker" => "KXRECEIPTTEST-A", "observations" => 2,
        "first_observed_at" => "2026-11-05T10:00:00.123456789Z", "latest_observed_at" => "2026-11-05T10:01:00Z",
        "first_midpoint" => 0.5, "latest_midpoint" => 0.6, "latest_spread" => 0.2, "midpoint_change" => 0.1 }
    ]
  }
end

def calibration_fixture
  bins = 10.times.map do |index|
    { "lower" => index / 10.0, "upper" => (index + 1) / 10.0, "sample_count" => 0,
      "mean_probability_yes" => nil, "observed_yes_rate" => nil }
  end
  bins[7].merge!("sample_count" => 1, "mean_probability_yes" => 0.75, "observed_yes_rate" => 1)
  {
    "sample_count" => 1, "brier_score" => 0.0625, "log_loss" => -Math.log(0.75), "log_loss_epsilon" => 1e-15,
    "baseline_probability_yes" => 0.5, "baseline_brier_score" => 0.25, "baseline_log_loss" => Math.log(2),
    "reliability_bins" => bins
  }
end

depth = depth_fixture
calibration = calibration_fixture
receipt = PredictirReceipts.build(depth, calibration)
id = receipt.fetch("id")
assert(PredictirReceipts::DIGEST.match?(id), "receipt ID must be SHA-256")
assert(receipt.dig("receipt", "depth", "markets").map { |market| market.fetch("ticker") } == %w[KXRECEIPTTEST-A KXRECEIPTTEST-B],
       "markets must be normalized by exact ticker")
assert(receipt.dig("receipt", "depth", "markets", 0, "first_observed_at") == "2026-11-05T10:00:00.123456789Z",
       "a nanosecond timestamp must survive")
depth["markets"].reverse!
assert(receipt == PredictirReceipts.build(depth.to_a.reverse.to_h, calibration.to_a.reverse.to_h),
       "field and market order must not change the receipt")
assert(id != PredictirReceipts.build(depth, calibration.merge("brier_score" => 0.07)).fetch("id"),
       "a changed score must change the receipt ID")
rejects("unknown/private fields must fail closed") { PredictirReceipts.build(depth.merge("owner_email" => "private"), calibration) }
rejects("quote counts must reconcile") { PredictirReceipts.build(depth.merge("quote_count" => 4), calibration) }
rejects("calibration counts must reconcile") { PredictirReceipts.build(depth, calibration.merge("sample_count" => 2)) }
rejects("duplicate tickers must be rejected") do
  PredictirReceipts.build(depth.merge("markets" => [depth["markets"][0], depth["markets"][0]], "quote_count" => 4), calibration)
end
rejects("invalid timestamp must be rejected") do
  bad = depth_fixture
  bad["markets"][0]["latest_observed_at"] = "2026-11-31T10:00:00Z"
  PredictirReceipts.build(bad, calibration)
end
rejects("invalid baseline must be rejected") { PredictirReceipts.build(depth, calibration.merge("baseline_brier_score" => 0.5)) }

Dir.mktmpdir("predictir-receipts-test") do |directory|
  depth_path = File.join(directory, "depth.json")
  calibration_path = File.join(directory, "calibration.json")
  File.write(depth_path, JSON.generate(depth))
  File.write(calibration_path, JSON.generate(calibration))
  args = ["create", "--depth", depth_path, "--calibration", calibration_path]
  output, error = StringIO.new, StringIO.new
  code = PredictirReceipts.run(args.dup, stdout: output, stderr: error)
  assert(code.zero? && error.string.empty? && JSON.parse(output.string) == receipt, "CLI must produce the normalized receipt")
  output = StringIO.new
  code = PredictirReceipts.run(args + ["--format", "markdown"], stdout: output, stderr: error)
  assert(code.zero? && output.string.include?("## Settled forecast evaluation") && output.string.include?(id),
         "Markdown must describe the same receipt")
  File.write(depth_path, '{"schema":1,"schema":2}')
  rejects("duplicate JSON field must be rejected") { PredictirReceipts.read_report(depth_path) }
  File.write(depth_path, " " * (PredictirReceipts::MAX_REPORT_BYTES + 1))
  rejects("oversized report must be rejected") { PredictirReceipts.read_report(depth_path) }
end

test_uri = ENV["PREDICTIR_RECEIPTS_TEST_MONGODB_URI"]
if test_uri
  unless test_uri.match?(%r{\Amongodb://(?:localhost|127\.0\.0\.1|mongo)(?::[0-9]+)?/?\z})
    raise "Archive test must use a dedicated local MongoDB instance"
  end
  ENV[PredictirReceipts::URI_ENV] = test_uri
  PredictirReceipts::Archive.open do |archive|
    writers = 2.times.map { Thread.new { archive.put(receipt) } }
    assert(writers.map(&:value) == [receipt, receipt], "concurrent MongoDB writers must return the same receipt")
    assert(archive.put(receipt) == receipt, "MongoDB duplicate write must be idempotent")
    assert(archive.get(id) == receipt, "MongoDB read must verify the stored digest")
  end
  Dir.mktmpdir("predictir-receipts-archive-test") do |directory|
    depth_path = File.join(directory, "depth.json")
    calibration_path = File.join(directory, "calibration.json")
    File.write(depth_path, JSON.generate(depth))
    File.write(calibration_path, JSON.generate(calibration))
    output, error = StringIO.new, StringIO.new
    create = ["create", "--depth", depth_path, "--calibration", calibration_path, "--archive"]
    assert(PredictirReceipts.run(create, stdout: output, stderr: error).zero? && JSON.parse(output.string) == receipt,
           "archive command must print the verified receipt")
    output = StringIO.new
    assert(PredictirReceipts.run(["get", id], stdout: output, stderr: error).zero? && JSON.parse(output.string) == receipt,
           "get command must print the verified receipt")
  end
  client = Mongo::Client.new(test_uri, database: PredictirReceipts::DATABASE)
  begin
    collection = client[PredictirReceipts::COLLECTION]
    assert(collection.count_documents("_id" => id) == 1, "duplicate writes must keep one document")
    collection.find("_id" => id).update_one("$set" => { "receipt.calibration.brier_score" => 0.07 })
    rejects("tampering must fail the digest check") do
      PredictirReceipts::Archive.open { |archive| archive.get(id) }
    end
    collection.find("_id" => id).delete_one
  ensure
    client.close
  end
  puts "MongoDB integration checks passed"
else
  saved_uri = ENV.delete(PredictirReceipts::URI_ENV)
  rejects("archive requires explicit configuration") { PredictirReceipts::Archive.open { raise "unexpected connection" } }
  ENV[PredictirReceipts::URI_ENV] = saved_uri if saved_uri
end
puts "Receipt checks passed"
