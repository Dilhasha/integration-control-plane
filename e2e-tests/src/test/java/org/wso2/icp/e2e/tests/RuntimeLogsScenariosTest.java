package org.wso2.icp.e2e.tests;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.assertions.LocatorAssertions;
import com.microsoft.playwright.options.AriaRole;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.wso2.icp.e2e.BaseObservabilityE2ETest;
import org.wso2.icp.e2e.E2EEnvironment;

import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

@Tag("e2e")
@Tag("observability")
@DisplayName("Runtime logs scenarios")
class RuntimeLogsScenariosTest extends BaseObservabilityE2ETest {
    private String project;
    private String environment;
    private String biComponent;
    private String miComponent;
    private String biRuntimeId;
    private String miRuntimeId;
    private String biLogMessage;
    private String miLogMessage;
    private String biSecret;
    private String miSecret;

    @AfterEach
    void releaseRuntimes() {
        E2EEnvironment.stopRuntimes();
    }

    @Test
    @DisplayName("Project and component logs")
    void projectAndComponentLogsShowOpenSearchEntries() throws Exception {
        page.setDefaultTimeout(Math.max(config.timeoutMs(), 120_000));

        signInAsAdmin();
        createUiSetup();
        startRealRuntimesAndEmitLogs();

        openProjectLogs();
        assertRuntimeLogsPage();
        assertProjectFilters();
        waitForLogEntries();
        try {
            assertLogTextVisible(biLogMessage);
            assertLogTextVisible(miLogMessage);
        } catch (AssertionError e) {
            E2EEnvironment.captureDiagnostics("project logs missing expected entries");
            throw e;
        }

        chooseLogLevel("INFO");
        waitForLogEntries();

        expandFirstLogEntry();
        assertThat(page.getByText("Log Level", new Page.GetByTextOptions().setExact(true))).isVisible();
        assertThat(page.getByText("Runtime ID", new Page.GetByTextOptions().setExact(true))).isVisible();

        page.navigate(config.url("/organizations/default/projects/" + project + "/components/" + biComponent + "/logs"));
        assertRuntimeLogsPage();
        assertThat(select("Integration")).not().isVisible();
        openSelect("Environment");
        assertThat(option(environment)).isVisible();
        page.keyboard().press("Escape");

        assertMiRuntimeInventoryAndOperations();
    }

    private void createUiSetup() throws Exception {
        String suffix = Long.toString(System.currentTimeMillis(), 36).toLowerCase();
        project = "e2e-project-" + suffix;
        environment = "e2e-env-" + suffix;
        biComponent = "e2e-bi-" + suffix;
        miComponent = "e2e-mi-" + suffix;
        biRuntimeId = UUID.randomUUID().toString();
        miRuntimeId = UUID.randomUUID().toString();

        createProject(project);
        createEnvironment(environment);
        createComponent(biComponent, false);
        createComponent(miComponent, true);

        biSecret = createRuntimeSecret(biComponent);
        miSecret = createRuntimeSecret(miComponent);
    }

    private void startRealRuntimesAndEmitLogs() throws Exception {
        biLogMessage = "E2E BI application log " + biRuntimeId;
        miLogMessage = "E2E MI application log " + miRuntimeId;
        E2EEnvironment.RuntimeProcess bi = E2EEnvironment.startBiRuntime(biRuntimeId, environment, project, biComponent, biSecret);
        E2EEnvironment.RuntimeProcess mi = E2EEnvironment.startMiRuntime(miRuntimeId, environment, project, miComponent, miSecret, miLogMessage);
        E2EEnvironment.startLogCollector();
        E2EEnvironment.waitUntilReachable(bi.url());
        E2EEnvironment.waitUntilReachable(mi.url());
        E2EEnvironment.awaitLogIndexed(biLogMessage);
        E2EEnvironment.awaitLogIndexed(miLogMessage);
    }

    private void createProject(String handler) {
        page.navigate(config.url("/organizations/default/projects/new"));
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("Create a Project"))).isVisible();
        page.getByLabel("Display Name").fill(handler);
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Create")).click();
        assertThat(page).hasURL(Pattern.compile(".*/organizations/default/projects/" + handler + "/?$"));
    }

    private void createEnvironment(String handler) {
        page.navigate(config.url("/organizations/default/environments/new"));
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("Create Environment"))).isVisible();
        page.getByPlaceholder("e.g., Staging Environment").fill(handler);
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Create")).click();
        assertThat(page).hasURL(Pattern.compile(".*/organizations/default/environments$"));
    }

    private void createComponent(String handler, boolean mi) {
        page.navigate(config.url("/organizations/default/projects/" + project + "/components/new"));
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("Create New Integration"))).isVisible();
        page.getByLabel("Display Name").fill(handler);
        if (mi) {
            page.getByRole(AriaRole.RADIO, new Page.GetByRoleOptions().setName("WSO2 Integrator: MI").setExact(true)).click();
        }
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Create")).click();
        assertThat(page).hasURL(Pattern.compile(".*/organizations/default/projects/" + project + "/components/" + handler + "/?$"));
    }

    private String createRuntimeSecret(String component) {
        page.navigate(config.url("/organizations/default/projects/" + project + "/components/" + component + "/runtimes"));
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("Runtime"))).isVisible();
        environmentCard().getByRole(AriaRole.BUTTON, new Locator.GetByRoleOptions().setName("Add Runtime")).click();
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("Add Runtime for " + environment))).isVisible();
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Generate Secret")).click();
        Locator pre = page.locator("pre").first();
        assertThat(pre).isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(30_000));
        String configText = pre.textContent();
        Matcher matcher = Pattern.compile("secret\\s*=\\s*\"([^\"]+)\"").matcher(configText);
        if (!matcher.find()) throw new IllegalStateException("Secret not found in generated runtime config");
        String secret = matcher.group(1);
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Close")).click();
        return secret;
    }

    private void openProjectLogs() {
        page.navigate(config.url("/organizations/default/projects/" + project + "/logs"));
    }

    private void assertMiRuntimeInventoryAndOperations() {
        page.navigate(config.url("/organizations/default/projects/" + project + "/components/" + miComponent + "/runtimes"));
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("Runtime"))).isVisible();
        Locator card = environmentCard();
        card.getByLabel("Search runtimes...").fill(miRuntimeId);
        assertThat(card.getByText(miRuntimeId).first()).isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(120_000));
        assertThat(card.getByText("RUNNING").first()).isVisible();
        card.getByLabel("View logs for " + miRuntimeId).click();
        assertThat(page.getByText("Log Files - " + miRuntimeId)).isVisible();
        assertThat(page.getByText(Pattern.compile("[0-9]+ log files? found|No log files available")))
                .isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(60_000));
        page.getByLabel("Search log files...").fill("carbon");
        assertThat(page.getByText(Pattern.compile("[0-9]+ log files? found|No log files match your search|wso2carbon.log")))
                .isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(60_000));
        page.getByLabel("close").last().click();

        page.navigate(config.url("/organizations/default/projects/" + project + "/components/" + miComponent + "/loggers"));
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName(miComponent))).isVisible();
        assertThat(page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Add Logger")))
                .isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(120_000));
        addMiLogger();

        page.navigate(config.url("/organizations/default/projects/" + project + "/components/" + miComponent));
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName(miComponent))).isVisible();
        Locator componentCard = environmentCard();
        componentCard.getByLabel("Refresh").click();
        assertThat(page.getByText(Pattern.compile("E2ELogAPI|No entry points found")).first())
                .isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(120_000));
        if (page.getByText("E2ELogAPI").isVisible()) {
            page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("View Source")).click();
            assertThat(page.getByText("E2ELogAPI").last()).isVisible();
            assertThat(page.getByText("/e2e").first()).isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(60_000));
            page.getByLabel("close").last().click();
        }
        componentCard.getByRole(AriaRole.BUTTON, new Locator.GetByRoleOptions().setName("Supporting Artifacts")).click();
        page.waitForTimeout(1_000);
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName(miComponent))).isVisible();
    }

    private Locator environmentCard() {
        return page.locator("xpath=//h2[normalize-space()='" + environment + "']/ancestor::*[contains(@class,'MuiCardContent-root')][1]");
    }

    private void addMiLogger() {
        String loggerName = "org.wso2.e2e." + miRuntimeId.substring(0, 8);
        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Add Logger")).click();
        Locator dialog = page.getByRole(AriaRole.DIALOG);
        dialog.getByLabel("Logger Name").fill(loggerName);
        dialog.getByLabel("Logger Class").fill(loggerName);
        dialog.getByRole(AriaRole.BUTTON, new Locator.GetByRoleOptions().setName("Add Logger")).click();
        assertThat(dialog).not().isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(60_000));
    }

    private void assertRuntimeLogsPage() {
        assertThat(page).hasURL(Pattern.compile(".*/logs$"));
        assertThat(page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("Runtime Logs"))).isVisible();
        assertThat(select("Environment")).isVisible();
        assertThat(select("Log level")).isVisible();
        assertThat(select("Time range")).isVisible();
        assertThat(select("Sort direction")).isVisible();
        assertThat(page.getByLabel("Search logs...")).isVisible();
        assertThat(page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Refresh"))).isVisible();
        assertThat(page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Download logs"))).isVisible();
    }

    private void assertProjectFilters() {
        assertThat(select("Integration")).isVisible();
        openSelect("Integration");
        assertThat(option(biComponent)).isVisible();
        assertThat(option(miComponent)).isVisible();
        page.keyboard().press("Escape");

        openSelect("Environment");
        assertThat(option(environment)).isVisible();
        page.keyboard().press("Escape");
    }

    private void assertLogTextVisible(String text) {
        assertThat(page.getByText(text).first()).isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(120_000));
    }

    private void chooseLogLevel(String level) {
        openSelect("Log level");
        option(level).click();
        page.keyboard().press("Escape");
    }

    private void openSelect(String label) {
        select(label).click();
    }

    private Locator select(String label) {
        return page.getByLabel(label, new Page.GetByLabelOptions().setExact(true));
    }

    private Locator option(String name) {
        return page.getByRole(AriaRole.OPTION, new Page.GetByRoleOptions().setName(name).setExact(true));
    }

    private void waitForLogEntries() {
        Locator entries = page.getByText(Pattern.compile("[1-9][0-9]* entries? loaded"));
        assertThat(entries.first()).isVisible(new LocatorAssertions.IsVisibleOptions().setTimeout(120_000));
    }

    private void expandFirstLogEntry() {
        page.getByLabel("Expand log entry").first().click();
    }
}
