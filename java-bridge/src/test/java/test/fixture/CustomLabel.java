package test.fixture;

import java.io.Serial;
import java.io.Serializable;

/** Test-only application class used to verify custom JMX argument classpaths. */
public final class CustomLabel implements Serializable {
    @Serial
    private static final long serialVersionUID = 1L;
    private final String value;

    /** Creates a serializable test label from its text value. */
    public CustomLabel(String value) {
        this.value = value;
    }

    /** Returns the label value used by the integration test. */
    @Override
    public String toString() {
        return "label=" + value;
    }
}
