import javax.management.MBeanServer;
import javax.management.Notification;
import javax.management.NotificationBroadcasterSupport;
import javax.management.ObjectName;
import javax.management.StandardMBean;
import javax.management.remote.JMXConnectorServer;
import javax.management.remote.JMXConnectorServerFactory;
import javax.management.remote.JMXServiceURL;
import test.fixture.CustomLabel;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.management.ManagementFactory;
import java.rmi.registry.LocateRegistry;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** Starts a small local JMX server used by the Node.js integration test. */
public class JmxTestServer {
    /** Runs the test MBean server until its standard input is closed. */
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        LocateRegistry.createRegistry(port);
        MBeanServer server = ManagementFactory.getPlatformMBeanServer();
        server.registerMBean(new Counter(), new ObjectName("test.jmx:type=Counter"));
        JMXServiceURL url = new JMXServiceURL(
            "service:jmx:rmi:///jndi/rmi://127.0.0.1:" + port + "/jmxrmi");
        JMXConnectorServer connector = JMXConnectorServerFactory.newJMXConnectorServer(url, null, server);
        connector.start();
        System.out.println("READY");
        try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in))) {
            while (input.readLine() != null) {
                // Keep the server available until the test closes the process pipe.
            }
        } finally {
            connector.stop();
        }
    }

    /** Exposes a writable long attribute and an increment operation as a standard MBean. */
    public interface CounterMBean {
        /** Returns the current counter value as a Java long. */
        long getCount();

        /** Replaces the counter value. */
        void setCount(long value);

        /** Adds an integer amount and returns the updated counter value. */
        long increment(int amount);

        /** Returns the endpoint passed through the JMX bridge. */
        String describe(java.net.InetSocketAddress address);

        /** Returns a custom application class passed through the configured classpath. */
        String describeLabel(CustomLabel label);
        Map<String, String> values();

        /** Returns a long value above the JavaScript safe-integer threshold. */
        long getBigCount();

        /** Returns a map keyed by non-string objects to exercise typed-key encoding. */
        Map<Integer, String> getIntegerKeyedMap();

        /** Publishes a notification observed by subscribed clients. */
        void publishNotification(String message);
    }

    /** Implements the integration-test MBean operations and broadcasts notifications. */
    public static class Counter extends NotificationBroadcasterSupport implements CounterMBean {
        private final AtomicLong notificationSequence = new AtomicLong();
        private long count = 1;

        /** Returns the current counter value. */
        public long getCount() {
            return count;
        }

        /** Replaces the counter value. */
        public void setCount(long value) {
            count = value;
        }

        /** Adds an integer amount and returns the updated counter. */
        public long increment(int amount) {
            count += amount;
            return count;
        }

        /** Returns the host and port from a reflectively constructed Java argument. */
        public String describe(java.net.InetSocketAddress address) {
            return address.getHostString() + ":" + address.getPort();
        }

        /** Returns a custom Java argument value received over the JMX connection. */
        public String describeLabel(CustomLabel label) {
            return label.toString();
        }

        /** Returns a map containing a key that collides with the bridge's internal type tag. */
        public Map<String, String> values() {
            return Map.of("$jmxType", "ordinary-value");
        }

        /** Returns a long value that cannot be represented as a safe JavaScript integer. */
        public long getBigCount() {
            return 9007199254740993L;
        }

        /** Returns a map whose keys cannot be transferred as plain JSON object property names. */
        public Map<Integer, String> getIntegerKeyedMap() {
            Map<Integer, String> result = new HashMap<>();
            result.put(1, "one");
            result.put(2, "two");
            return result;
        }

        /** Sends one JMX notification whose message mirrors the supplied argument. */
        public void publishNotification(String message) {
            sendNotification(new Notification("test.jmx.counter",
                this, notificationSequence.incrementAndGet(), message));
        }
    }
}
