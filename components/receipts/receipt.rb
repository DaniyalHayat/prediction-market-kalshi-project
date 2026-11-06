require "digest"
require "json"
require "optparse"
require "time"

module PredictirReceipts
  class Invalid < StandardError; end

  class UniqueObject < Hash
    def []=(key, value)
      raise Invalid, "Duplicate JSON field" if key?(key)
      super
    end
  end

  SCHEMA = "predictir.run-receipt.v1"
  DEPTH_SCHEMA = "predictir.depth-replay.v1"
  DATABASE = "predictir_research"
  COLLECTION = "run_receipts"
  URI_ENV = "PREDICTIR_RECEIPTS_MONGODB_URI"
  MAX_REPORT_BYTES = 2 * 1024 * 1024
  MAX_COUNT = 1_000_000
  DIGEST = /\A[0-9a-f]{64}\z/
  TICKER = /\A[A-Z0-9][A-Z0-9._:-]{0,139}\z/
  UTC_TIME = /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?Z\z/
  DEPTH_FIELDS = %w[schema quote_count markets].freeze
  MARKET_FIELDS = %w[ticker observations first_observed_at latest_observed_at first_midpoint latest_midpoint latest_spread midpoint_change].freeze
  CALIBRATION_FIELDS = %w[sample_count brier_score log_loss baseline_probability_yes baseline_brier_score baseline_log_loss log_loss_epsilon reliability_bins].freeze
  BIN_FIELDS = %w[lower upper sample_count mean_probability_yes observed_yes_rate].freeze

  module_function

  def exact_fields(value, names, label)
    unless value.is_a?(Hash) && value.keys.sort == names.sort
      raise Invalid, "Unexpected fields in #{label}"
    end
    value
  end

  def count(value, label, minimum: 1)
    return value if value.is_a?(Integer) && value.between?(minimum, MAX_COUNT)
    raise Invalid, "Invalid #{label} count"
  end

  def number(value, minimum, maximum, label)
    unless (value.is_a?(Float) || value.is_a?(Integer)) && value.finite? && value.between?(minimum, maximum)
      raise Invalid, "Invalid #{label}"
    end
    value.zero? ? 0.0 : value.to_f
  end

  def time(value)
    raise Invalid, "Invalid UTC quote timestamp" unless value.is_a?(String) && UTC_TIME.match?(value)
    parsed = Time.iso8601(value)
    canonical = parsed.utc.iso8601(9).sub(/(\.\d*?[1-9])0+Z\z/, '\1Z').sub(/\.0+Z\z/, "Z")
    raise Invalid, "Noncanonical UTC quote timestamp" unless parsed.strftime("%Y-%m-%dT%H:%M:%S") == value[0, 19]
    [parsed, canonical]
  rescue ArgumentError
    raise Invalid, "Invalid UTC quote timestamp"
  end

  def market(value)
    exact_fields(value, MARKET_FIELDS, "market summary")
    ticker = value["ticker"]
    raise Invalid, "Invalid market ticker" unless ticker.is_a?(String) && TICKER.match?(ticker)
    observations = count(value["observations"], "market observation")
    first_time, first_label = time(value["first_observed_at"])
    latest_time, latest_label = time(value["latest_observed_at"])
    unless observations == 1 ? first_time == latest_time : first_time < latest_time
      raise Invalid, "Market observations and timestamp order disagree"
    end
    first = number(value["first_midpoint"], 0, 1, "first midpoint")
    latest = number(value["latest_midpoint"], 0, 1, "latest midpoint")
    spread = number(value["latest_spread"], 0, 1, "latest spread")
    change = number(value["midpoint_change"], -1, 1, "midpoint change")
    unless (latest - first - change).abs <= 1e-9 && spread <= 2 * [latest, 1 - latest].min + 1e-9
      raise Invalid, "Market midpoint and spread do not reconcile"
    end
    {
      "ticker" => ticker, "observations" => observations,
      "first_observed_at" => first_label, "latest_observed_at" => latest_label,
      "first_midpoint" => first, "latest_midpoint" => latest,
      "latest_spread" => spread, "midpoint_change" => change
    }
  end

  def depth(value)
    exact_fields(value, DEPTH_FIELDS, "depth report")
    raise Invalid, "Unexpected depth schema" unless value["schema"] == DEPTH_SCHEMA
    total = count(value["quote_count"], "quote")
    summaries = value["markets"]
    unless summaries.is_a?(Array) && summaries.length.between?(1, 10_000)
      raise Invalid, "Invalid market summary count"
    end
    markets = summaries.map { |summary| market(summary) }.sort_by { |summary| summary["ticker"] }
    if markets.map { |summary| summary["ticker"] }.uniq.length != markets.length
      raise Invalid, "Repeated market summary"
    end
    unless markets.sum { |summary| summary["observations"] } == total
      raise Invalid, "Market observations do not add up to the quote count"
    end
    { "schema" => DEPTH_SCHEMA, "quote_count" => total, "markets" => markets }
  end

  def reliability_bin(value, index)
    exact_fields(value, BIN_FIELDS, "reliability bin")
    lower = number(value["lower"], 0, 1, "bin lower bound")
    upper = number(value["upper"], 0, 1, "bin upper bound")
    unless lower == index / 10.0 && upper == (index + 1) / 10.0
      raise Invalid, "Unexpected reliability bin boundaries"
    end
    samples = count(value["sample_count"], "bin sample", minimum: 0)
    mean = value["mean_probability_yes"]
    observed = value["observed_yes_rate"]
    if samples.zero?
      raise Invalid, "An empty bin must have null rates" unless mean.nil? && observed.nil?
    else
      mean = number(mean, lower - 1e-12, upper + 1e-12, "bin mean probability")
      observed = number(observed, 0, 1, "bin observed rate")
    end
    {
      "lower" => lower, "upper" => upper, "sample_count" => samples,
      "mean_probability_yes" => mean, "observed_yes_rate" => observed
    }
  end

  def calibration(value)
    exact_fields(value, CALIBRATION_FIELDS, "calibration report")
    samples = count(value["sample_count"], "calibration sample")
    epsilon = number(value["log_loss_epsilon"], 1e-15, 1e-15, "log loss epsilon")
    bins = value["reliability_bins"]
    raise Invalid, "Expected ten reliability bins" unless bins.is_a?(Array) && bins.length == 10
    bins = bins.each_with_index.map { |bin, index| reliability_bin(bin, index) }
    unless bins.sum { |bin| bin["sample_count"] } == samples
      raise Invalid, "Reliability bins do not add up to the sample count"
    end
    {
      "sample_count" => samples,
      "brier_score" => number(value["brier_score"], 0, 1, "Brier score"),
      "log_loss" => number(value["log_loss"], 0, -Math.log(epsilon) + 1e-10, "log loss"),
      "baseline_probability_yes" => number(value["baseline_probability_yes"], 0.5, 0.5, "baseline probability"),
      "baseline_brier_score" => number(value["baseline_brier_score"], 0.25 - 1e-12, 0.25 + 1e-12, "baseline Brier score"),
      "baseline_log_loss" => number(value["baseline_log_loss"], Math.log(2) - 1e-10, Math.log(2) + 1e-10, "baseline log loss"),
      "log_loss_epsilon" => epsilon, "reliability_bins" => bins
    }
  end

  def read_report(path)
    bytes = File.binread(path, MAX_REPORT_BYTES + 1)
    raise Invalid, "Summary exceeds the 2 MiB input limit" if bytes.bytesize > MAX_REPORT_BYTES
    JSON.parse(bytes, max_nesting: 12, object_class: UniqueObject)
  rescue JSON::ParserError, EncodingError
    raise Invalid, "Invalid summary JSON"
  rescue SystemCallError, IOError
    raise Invalid, "Unable to read summary file"
  end

  def canonical_value(value)
    case value
    when Hash
      value.sort_by { |key, _| key }.to_h.transform_values { |item| canonical_value(item) }
    when Array
      value.map { |item| canonical_value(item) }
    else
      value
    end
  end

  def canonical_json(value)
    JSON.generate(canonical_value(value))
  end

  def build(depth_report, calibration_report)
    body = { "schema" => SCHEMA, "depth" => depth(depth_report), "calibration" => calibration(calibration_report) }
    { "id" => Digest::SHA256.hexdigest(canonical_json(body)), "receipt" => body }
  end

  def render(value, format)
    return JSON.pretty_generate(value) + "\n" if format == "json"
    receipt = value.fetch("receipt")
    depth = receipt.fetch("depth")
    calibration = receipt.fetch("calibration")
    lines = [
      "# Predictir research run receipt", "",
      "Receipt `#{value.fetch('id')}`", "",
      "## Market depth replay", "",
      "#{depth.fetch('quote_count')} observations across #{depth.fetch('markets').length} markets.", "",
      "| Contract | Observations | Latest quote at UTC | YES midpoint (USD) | Spread (USD) | Change (USD) |",
      "| --- | ---: | --- | ---: | ---: | ---: |"
    ]
    depth.fetch("markets").each do |market|
      row = %w[ticker observations latest_observed_at latest_midpoint latest_spread midpoint_change].map { |key| market.fetch(key) }
      lines << "| #{row.join(' | ')} |"
    end
    lines.concat([
      "", "## Settled forecast evaluation", "",
      "Sample count: #{calibration.fetch('sample_count')}", "",
      "| Score | Forecast | Fixed 50% baseline |", "| --- | ---: | ---: |",
      "| Brier | #{calibration.fetch('brier_score')} | #{calibration.fetch('baseline_brier_score')} |",
      "| Log loss | #{calibration.fetch('log_loss')} | #{calibration.fetch('baseline_log_loss')} |",
      "", "| Forecast bin | Samples | Mean forecast | Observed YES rate |", "| --- | ---: | ---: | ---: |"
    ])
    calibration.fetch("reliability_bins").each do |bin|
      row = %w[sample_count mean_probability_yes observed_yes_rate].map { |key| bin[key].nil? ? "—" : bin[key] }
      lines << "| #{bin.fetch('lower')}–#{bin.fetch('upper')} | #{row.join(' | ')} |"
    end
    lines.concat(["", "The digest identifies the normalized summaries. Sample scores describe the supplied settlements.", ""]).join("\n")
  end

  class Archive
    def self.open
      uri = ENV[URI_ENV]
      unless uri && uri.match?(/\Amongodb(?:\+srv)?:\/\//)
        raise Invalid, "Set #{URI_ENV} to use the optional archive"
      end
      begin
        require "mongo"
      rescue LoadError
        raise Invalid, "Install the pinned MongoDB driver with Bundler"
      end
      Mongo::Logger.logger.level = Logger::FATAL
      begin
        client = Mongo::Client.new(uri, database: DATABASE, server_selection_timeout: 5, connect_timeout: 5, socket_timeout: 5,
                                  write: { w: "majority" })
        yield new(client[COLLECTION])
      rescue Mongo::Error => error
        raise Invalid, "MongoDB archive request failed (#{error.class.name.split('::').last})"
      ensure
        client&.close
      end
    end

    def initialize(collection)
      @collection = collection
    end

    def put(value)
      id = value.fetch("id")
      body = value.fetch("receipt")
      begin
        @collection.insert_one("_id" => id, "receipt" => body)
      rescue Mongo::Error::OperationFailure => error
        raise unless error.code == 11000
      end
      archived = get(id)
      unless PredictirReceipts.canonical_json(archived) == PredictirReceipts.canonical_json(value)
        raise Invalid, "Stored receipt differs from the submitted summary"
      end
      archived
    end

    def get(id)
      raise Invalid, "Expected a lowercase SHA-256 receipt ID" unless DIGEST.match?(id)
      stored = @collection.find("_id" => id).limit(1).first
      raise Invalid, "Receipt was not found" unless stored
      PredictirReceipts.exact_fields(stored, %w[_id receipt], "archived document")
      body = PredictirReceipts.exact_fields(stored["receipt"], %w[schema depth calibration], "archived receipt")
      value = PredictirReceipts.build(body["depth"], body["calibration"])
      unless id == stored["_id"] && id == value.fetch("id") &&
             PredictirReceipts.canonical_json(body) == PredictirReceipts.canonical_json(value.fetch("receipt"))
        raise Invalid, "Stored receipt failed its digest check"
      end
      value
    end
  end

  def run(args, stdout: $stdout, stderr: $stderr)
    command = args.shift
    options = { format: "json", archive: false }
    parser = OptionParser.new do |opt|
      opt.banner = "Usage: receipt.rb create --depth FILE --calibration FILE [--archive] [--format json|markdown]\n" \
                   "       receipt.rb get SHA256 [--format json|markdown]"
      opt.on("--depth FILE") { |path| options[:depth] = path }
      opt.on("--calibration FILE") { |path| options[:calibration] = path }
      opt.on("--format FORMAT", %w[json markdown]) { |format| options[:format] = format }
      opt.on("--archive") { options[:archive] = true }
      opt.on("-h", "--help") { stdout.puts(opt); return 0 }
    end
    if command.nil? || %w[-h --help].include?(command)
      stdout.puts(parser)
      return 0
    end
    parser.parse!(args)
    case command
    when "create"
      unless args.empty? && options[:depth] && options[:calibration]
        raise Invalid, "Create requires --depth and --calibration"
      end
      value = build(read_report(options[:depth]), read_report(options[:calibration]))
      value = Archive.open { |archive| archive.put(value) } if options[:archive]
    when "get"
      unless args.length == 1 && DIGEST.match?(args.first) && !options[:depth] && !options[:calibration] && !options[:archive]
        raise Invalid, "Get requires one lowercase SHA-256 receipt ID"
      end
      value = Archive.open { |archive| archive.get(args.first) }
    else
      raise Invalid, "Choose create or get"
    end
    stdout.write(render(value, options.fetch(:format)))
    0
  rescue OptionParser::ParseError
    stderr.puts("Invalid command option. Use --help for usage.")
    1
  rescue Invalid => error
    stderr.puts(error.message)
    1
  end
end

exit PredictirReceipts.run(ARGV) if $PROGRAM_NAME == __FILE__
