import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

public final class CalibrationTest {
    private static String row(String ticker, String probability, String outcome) {
        return """
            {"ticker":"%s","forecast_at":"2026-02-01T00:00:00Z","settled_at":"2026-02-02T00:00:00Z","probability_yes":%s,"outcome_yes":%s}
            """.formatted(ticker, probability, outcome);
    }

    private static byte[] score(String forecasts) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Calibration.run(new ByteArrayInputStream(forecasts.getBytes(StandardCharsets.UTF_8)), output);
        return output.toByteArray();
    }

    private static Map<String, Double> numberFields(JsonParser parser) throws IOException {
        Map<String, Double> result = new HashMap<>();
        while (parser.nextToken() == JsonToken.FIELD_NAME) {
            String field = parser.currentName();
            JsonToken token = parser.nextToken();
            if (token.isNumeric()) {
                result.put(field, parser.getDoubleValue());
            } else {
                parser.skipChildren();
            }
        }
        return result;
    }

    private static void close(double actual, double expected) {
        if (Math.abs(actual - expected) > 1e-12 || !Double.isFinite(actual)) {
            throw new AssertionError("Expected " + expected + ", received " + actual);
        }
    }

    private static void expectRejected(String forecasts, String reason) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            Calibration.run(new ByteArrayInputStream(forecasts.getBytes(StandardCharsets.UTF_8)), output);
        } catch (IllegalArgumentException error) {
            if (error.getMessage().contains(reason) && output.size() == 0) {
                return;
            }
            throw error;
        }
        throw new AssertionError("Expected rejection for " + reason);
    }

    private static void scoresAndBins() throws IOException {
        String forecasts = row("KX-FIRST", "0.8", "true") + row("KX-SECOND", "0.3", "false");
        byte[] result = score(forecasts);
        if (!Arrays.equals(result, score(forecasts))) {
            throw new AssertionError("Same input produced different results");
        }
        JsonFactory json = new JsonFactory();
        try (JsonParser parser = json.createParser(result)) {
            parser.nextToken();
            Map<String, Double> summary = numberFields(parser);
            close(summary.get("sample_count"), 2);
            close(summary.get("brier_score"), 0.065);
            close(summary.get("log_loss"), -(StrictMath.log(.8) + StrictMath.log(.7)) / 2);
            close(summary.get("baseline_probability_yes"), .5);
            close(summary.get("baseline_brier_score"), .25);
            close(summary.get("baseline_log_loss"), StrictMath.log(2));
        }
        try (JsonParser parser = json.createParser(result)) {
            while (parser.nextToken() != JsonToken.START_ARRAY) {
                if (parser.currentToken() == null) {
                    throw new AssertionError("Expected reliability bins");
                }
            }
            int bin = 0;
            while (parser.nextToken() == JsonToken.START_OBJECT) {
                Map<String, Double> fields = numberFields(parser);
                close(fields.get("lower"), bin / 10.0);
                close(fields.get("upper"), (bin + 1) / 10.0);
                close(fields.get("sample_count"), bin == 3 || bin == 8 ? 1 : 0);
                if (bin == 3 || bin == 8) {
                    close(fields.get("mean_probability_yes"), bin / 10.0);
                    close(fields.get("observed_yes_rate"), bin == 8 ? 1 : 0);
                } else if (fields.containsKey("mean_probability_yes") || fields.containsKey("observed_yes_rate")) {
                    throw new AssertionError("Empty bins must have null rates");
                }
                bin++;
            }
            close(bin, 10);
        }
    }

    private static void endpointsAndInputBoundaries() throws IOException {
        String forecasts = row("KX-FIRST", "0", "true") + "\r\n" + row("KX-SECOND", "1", "false").stripTrailing();
        try (JsonParser parser = new JsonFactory().createParser(score(forecasts))) {
            parser.nextToken();
            Map<String, Double> summary = numberFields(parser);
            close(summary.get("brier_score"), 1);
            close(summary.get("log_loss"), -StrictMath.log(1e-15));
        }
        String valid = row("KX-VALID", "0.5", "true");
        expectRejected(valid + row("kx-valid", "0.2", "false"), "duplicate market ticker");
        expectRejected(valid.replace("2026-02-01", "2026-02-03"), "must precede");
        expectRejected(row("KX-VALID", "1.00000000000000000000001", "true"), "must be within");
        expectRejected(row("KX-VALID", "0.5", "0"), "must be true or false");
        expectRejected(row("KX-VALID", "0.5", "null"), "must be true or false");
        expectRejected(valid.replace("\"ticker\":", "\"ticker\":\"DUP\",\"ticker\":"), "duplicate field");
        expectRejected(valid.replace("\"ticker\":", "\"unknown\":"), "unknown forecast field");
        expectRejected(valid.stripTrailing() + valid, "exactly one");
        expectRejected(" ".repeat(4097), "record exceeds");
        expectRejected(" \n", "no settled forecasts");
    }

    public static void main(String[] args) throws IOException {
        scoresAndBins();
        endpointsAndInputBoundaries();
        System.out.println("Calibration tests passed");
    }
}
