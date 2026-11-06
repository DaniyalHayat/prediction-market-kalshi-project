import com.fasterxml.jackson.core.JacksonException;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.core.StreamWriteFeature;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

public final class Calibration {
    private static final int MAX_LINE_BYTES = 4096;
    private static final int MAX_ROWS = 100_000;
    private static final long MAX_INPUT_BYTES = 64L * 1024 * 1024;
    private static final int BIN_COUNT = 10;
    private static final double LOG_LOSS_EPSILON = 1e-15;
    private static final Pattern TICKER = Pattern.compile("[A-Za-z0-9_.-]{1,140}");
    private static final JsonFactory JSON = JsonFactory.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
        .disable(StreamWriteFeature.AUTO_CLOSE_TARGET)
        .streamReadConstraints(StreamReadConstraints.builder()
            .maxDocumentLength(MAX_LINE_BYTES)
            .maxNestingDepth(1)
            .maxNameLength(32)
            .maxStringLength(180)
            .maxNumberLength(64)
            .build())
        .build();

    private record Forecast(String ticker, BigDecimal probability, boolean yes) {}

    private static final class Bin {
        private int count;
        private int yes;
        private double probabilitySum;

        void add(double probability, boolean outcome) {
            count++;
            yes += outcome ? 1 : 0;
            probabilitySum += probability;
        }

        void write(JsonGenerator output, int index) throws IOException {
            output.writeStartObject();
            output.writeNumberField("lower", (double) index / BIN_COUNT);
            output.writeNumberField("upper", (double) (index + 1) / BIN_COUNT);
            output.writeNumberField("sample_count", count);
            if (count == 0) {
                output.writeNullField("mean_probability_yes");
                output.writeNullField("observed_yes_rate");
            } else {
                output.writeNumberField("mean_probability_yes", probabilitySum / count);
                output.writeNumberField("observed_yes_rate", (double) yes / count);
            }
            output.writeEndObject();
        }
    }

    private static final class Scores {
        private final Set<String> tickers = new HashSet<>();
        private final Bin[] bins = new Bin[BIN_COUNT];
        private double squaredErrors;
        private double negativeLogLikelihoods;

        Scores() {
            for (int index = 0; index < bins.length; index++) {
                bins[index] = new Bin();
            }
        }

        void add(Forecast forecast) {
            if (tickers.size() == MAX_ROWS) {
                throw new IllegalArgumentException("forecast limit exceeded");
            }
            if (!tickers.add(forecast.ticker().toUpperCase(Locale.ROOT))) {
                throw new IllegalArgumentException("duplicate market ticker");
            }
            BigDecimal exact = forecast.probability();
            double probability = exact.doubleValue();
            double error = probability - (forecast.yes() ? 1.0 : 0.0);
            squaredErrors += error * error;
            negativeLogLikelihoods += logLoss(probability, forecast.yes());
            int index = Math.min(BIN_COUNT - 1, exact.scaleByPowerOfTen(1).intValue());
            bins[index].add(probability, forecast.yes());
        }

        void write(OutputStream target) throws IOException {
            int count = tickers.size();
            if (count == 0) {
                throw new IllegalArgumentException("no settled forecasts supplied");
            }
            try (JsonGenerator output = JSON.createGenerator(target)) {
                output.writeStartObject();
                output.writeNumberField("sample_count", count);
                output.writeNumberField("brier_score", squaredErrors / count);
                output.writeNumberField("log_loss", negativeLogLikelihoods / count);
                output.writeNumberField("baseline_probability_yes", 0.5);
                output.writeNumberField("baseline_brier_score", 0.25);
                output.writeNumberField("baseline_log_loss", StrictMath.log(2.0));
                output.writeNumberField("log_loss_epsilon", LOG_LOSS_EPSILON);
                output.writeArrayFieldStart("reliability_bins");
                for (int index = 0; index < bins.length; index++) {
                    bins[index].write(output, index);
                }
                output.writeEndArray();
                output.writeEndObject();
                output.writeRaw('\n');
            }
        }
    }

    private static double logLoss(double probability, boolean yes) {
        if (yes) {
            return -StrictMath.log(Math.max(probability, LOG_LOSS_EPSILON));
        }
        return 1.0 - probability < LOG_LOSS_EPSILON
            ? -StrictMath.log(LOG_LOSS_EPSILON)
            : -StrictMath.log1p(-probability);
    }

    private static String stringField(JsonParser parser, String field) throws IOException {
        if (parser.currentToken() != JsonToken.VALUE_STRING) {
            throw new IllegalArgumentException(field + " must be a string");
        }
        return parser.getText();
    }

    private static Instant instantField(JsonParser parser, String field) throws IOException {
        try {
            return Instant.parse(stringField(parser, field));
        } catch (DateTimeParseException error) {
            throw new IllegalArgumentException(field + " must be an ISO-8601 instant");
        }
    }

    private static BigDecimal probabilityField(JsonParser parser) throws IOException {
        if (!parser.currentToken().isNumeric()) {
            throw new IllegalArgumentException("probability_yes must be a JSON number");
        }
        BigDecimal value = parser.getDecimalValue();
        if (value.signum() < 0 || value.compareTo(BigDecimal.ONE) > 0 ||
            value.scale() < -1000 || value.scale() > 1000) {
            throw new IllegalArgumentException("probability_yes must be within [0, 1] at supported decimal precision");
        }
        return value;
    }

    private static boolean outcomeField(JsonParser parser) {
        if (parser.currentToken() != JsonToken.VALUE_TRUE && parser.currentToken() != JsonToken.VALUE_FALSE) {
            throw new IllegalArgumentException("outcome_yes must be true or false");
        }
        return parser.currentToken() == JsonToken.VALUE_TRUE;
    }

    private static Forecast readForecast(byte[] bytes) throws IOException {
        try (JsonParser parser = JSON.createParser(bytes)) {
            JsonToken token = parser.nextToken();
            if (token == null) {
                return null;
            }
            if (token != JsonToken.START_OBJECT) {
                throw new IllegalArgumentException("expected one forecast object");
            }
            String ticker = null;
            Instant forecastAt = null;
            Instant settledAt = null;
            BigDecimal probability = null;
            Boolean yes = null;
            while (parser.nextToken() == JsonToken.FIELD_NAME) {
                String field = parser.currentName();
                parser.nextToken();
                switch (field) {
                    case "ticker" -> ticker = stringField(parser, field);
                    case "forecast_at" -> forecastAt = instantField(parser, field);
                    case "settled_at" -> settledAt = instantField(parser, field);
                    case "probability_yes" -> probability = probabilityField(parser);
                    case "outcome_yes" -> yes = outcomeField(parser);
                    default -> throw new IllegalArgumentException("unknown forecast field");
                }
            }
            if (parser.currentToken() != JsonToken.END_OBJECT || parser.nextToken() != null) {
                throw new IllegalArgumentException("expected exactly one forecast object per line");
            }
            if (ticker == null || forecastAt == null || settledAt == null || probability == null || yes == null) {
                throw new IllegalArgumentException("forecast is missing a required field");
            }
            if (!TICKER.matcher(ticker).matches() || ticker.contains("..") || ticker.equals(".")) {
                throw new IllegalArgumentException("invalid market ticker");
            }
            if (!forecastAt.isBefore(settledAt)) {
                throw new IllegalArgumentException("forecast_at must precede settled_at");
            }
            return new Forecast(ticker, probability, yes);
        } catch (JacksonException error) {
            throw new IllegalArgumentException("invalid JSON record or duplicate field");
        }
    }

    private static void acceptLine(Scores scores, ByteArrayOutputStream line, long number) throws IOException {
        try {
            Forecast forecast = readForecast(line.toByteArray());
            if (forecast != null) {
                scores.add(forecast);
            }
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("line " + number + ": " + error.getMessage());
        }
        line.reset();
    }

    static void run(InputStream source, OutputStream target) throws IOException {
        InputStream input = new BufferedInputStream(source);
        ByteArrayOutputStream line = new ByteArrayOutputStream(256);
        Scores scores = new Scores();
        long bytes = 0;
        long lineNumber = 1;
        for (int next; (next = input.read()) != -1;) {
            if (++bytes > MAX_INPUT_BYTES) {
                throw new IllegalArgumentException("input exceeds 64 MiB");
            }
            if (next == '\n') {
                acceptLine(scores, line, lineNumber++);
            } else {
                if (line.size() == MAX_LINE_BYTES) {
                    throw new IllegalArgumentException("line " + lineNumber + ": record exceeds 4096 bytes");
                }
                line.write(next);
            }
        }
        if (line.size() > 0) {
            acceptLine(scores, line, lineNumber);
        }
        scores.write(target);
    }

    public static void main(String[] args) {
        if (args.length > 1) {
            System.err.println("Usage: java -cp <jackson-jar> Calibration.java [forecasts.ndjson]");
            System.exit(2);
        }
        try {
            if (args.length == 0) {
                run(System.in, System.out);
            } else {
                try (InputStream source = Files.newInputStream(Path.of(args[0]))) {
                    run(source, System.out);
                }
            }
        } catch (IllegalArgumentException error) {
            System.err.println("Calibration: " + error.getMessage());
            System.exit(2);
        } catch (IOException error) {
            System.err.println("Calibration: unable to read or write the evaluation");
            System.exit(1);
        }
    }
}
