import com.atxx.jhmcp.*;
import com.google.gson.*;
import io.modelcontextprotocol.kotlin.sdk.server.*;
import io.modelcontextprotocol.kotlin.sdk.types.*;
import jadx.api.*;
import jadx.api.plugins.input.data.annotations.EncodedValue;
import jadx.api.plugins.input.data.attributes.JadxAttrType;
import jadx.api.plugins.input.data.ICodeReader;
import jadx.api.plugins.input.data.IMethodRef;
import jadx.api.plugins.input.insns.InsnIndexType;
import jadx.api.plugins.input.insns.Opcode;
import jadx.api.plugins.input.insns.custom.ISwitchPayload;
import jadx.api.plugins.input.data.IFieldRef;
import jadx.core.utils.android.AndroidResourcesMap;
import jadx.core.dex.info.MethodInfo;
import jadx.core.dex.nodes.*;
import java.io.PrintStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.stream.Collectors;
import kotlin.Unit;
import kotlin.ResultKt;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlin.coroutines.intrinsics.IntrinsicsKt;
import kotlinx.coroutines.BuildersKt;
import kotlinx.io.CoreKt;
import kotlinx.io.JvmCoreKt;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.InputSource;

/** REA-owned metadata boundary for the unmodified jadx-headless-mcp 0.7.1 JAR. */
class ReaJadxBridge {
  private static final Gson JSON = new Gson();
  private final SessionHolder holder;
  private JadxSession indexedSession;
  private Map<String, List<ClassSnapshot>> classes = Map.of();
  private JadxSession manifestSession;
  private ManifestSnapshot manifestSnapshot;

  private record MethodSnapshot(String name, String rawName, String shortId, List<String> bodyAbsenceMarkers,
      Map<String, Object> summary) {}
  private record ClassSnapshot(JavaClass node, List<MethodSnapshot> methods, Map<String, Object> summary,
      Map<String, Object> summaryWithValues) {}
  private record ManifestSnapshot(String text, Map<String, Object> summary) {}

  private static final class InputFailure extends IllegalArgumentException {
    final String field;
    InputFailure(String field, String message) { super(message); this.field = field; }
  }

  private ReaJadxBridge(SessionHolder holder) { this.holder = holder; }

  private static CallToolResult text(String value, boolean failed) {
    return new CallToolResult(List.of(new TextContent(value, null, null)), failed, null, null);
  }

  private static CallToolResult json(Object value) { return text(JSON.toJson(value), false); }

  /** Translate the typed load outcome before upstream drops its exception identity. */
  static Object loadResult(Object result) {
    try { ResultKt.throwOnFailure(result); }
    catch (Throwable failure) {
      if (failure instanceof java.util.concurrent.CancellationException
          || failure instanceof Error && !(failure instanceof OutOfMemoryError)) return result;
      if (failure instanceof OutOfMemoryError) {
        String reason = failure.getMessage();
        boolean heap = "Java heap space".equals(reason) || "GC overhead limit exceeded".equals(reason);
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("kind", "jvm-memory-failure");
        reply.put("memory_area", heap ? "heap" : "unknown");
        reply.put("exception_type", "java.lang.OutOfMemoryError");
        if (reason != null) reply.put("message", reason);
        reply.put("max_heap_bytes", Runtime.getRuntime().maxMemory());
        return text(JSON.toJson(reply), true);
      }
      return text("load failed: " + failure.getMessage(), true);
    }
    SessionHolder.LoadResult loaded = (SessionHolder.LoadResult) result;
    Map<String, Object> reply = new LinkedHashMap<>();
    reply.put("state", "LOADED");
    reply.put("apk_path", loaded.getApkPath());
    reply.put("class_count", loaded.getClassCount());
    reply.put("raw_class_count", loaded.getRawClassCount());
    reply.put("resource_count", loaded.getResourceCount());
    reply.put("load_duration_ms", loaded.getLoadDurationMs());
    reply.put("decompile_timeout_ms", loaded.getDecompileTimeoutMs());
    reply.put("threads", loaded.getThreads());
    reply.put("code_cache_size", loaded.getCodeCacheSize());
    reply.put("resources", loaded.getResourceMode());
    if (!loaded.getIncludePackages().isEmpty()) reply.put("include_packages", loaded.getIncludePackages());
    if (!loaded.getExcludePackages().isEmpty()) reply.put("exclude_packages", loaded.getExcludePackages());
    return json(reply);
  }

  private Object load(kotlinx.serialization.json.JsonObject arguments, SessionConfig defaults,
      Continuation<? super CallToolResult> continuation) {
    JsonObject args = JsonParser.parseString(arguments.toString()).getAsJsonObject();
    String path = string(args, "path");
    SessionConfig options = defaults.withLoadOverrides(
        optionalString(args, "include_packages"), optionalString(args, "exclude_packages"),
        args.has("threads") ? integer(args, "threads", 1) : null,
        args.has("code_cache_size") ? integer(args, "code_cache_size", 64) : null,
        optionalString(args, "resources"));
    clearManifest();
    return loadCall(next -> holder.load(path, options, next), continuation);
  }

  static Object loadCall(kotlin.jvm.functions.Function1<Continuation<SessionHolder.LoadResult>, Object> load,
      Continuation<? super CallToolResult> continuation) {
    var forwarded = new java.util.concurrent.atomic.AtomicBoolean();
    Continuation<SessionHolder.LoadResult> resumed = new Continuation<>() {
      public CoroutineContext getContext() { return continuation.getContext(); }
      public void resumeWith(Object result) {
        if (!forwarded.compareAndSet(false, true)) throw new IllegalStateException("Load resumed twice");
        Object translated;
        try { translated = loadResult(result); }
        catch (Throwable failure) { translated = ResultKt.createFailure(failure); }
        // Keep the consumer outside the translation catch, including inline completion.
        continuation.resumeWith(translated);
      }
    };
    Object result;
    try { result = load.invoke(resumed); }
    catch (Throwable failure) {
      if (forwarded.get()) ResultKt.throwOnFailure(ResultKt.createFailure(failure));
      result = ResultKt.createFailure(failure);
    }
    if (result == IntrinsicsKt.getCOROUTINE_SUSPENDED()) return result;
    Object translated = loadResult(result);
    ResultKt.throwOnFailure(translated);
    return translated;
  }

  private static String optionalString(JsonObject args, String name) {
    return args.has(name) ? string(args, name) : null;
  }

  private static String string(JsonObject args, String name) {
    JsonElement value = args.get(name);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
      throw new IllegalArgumentException(name + " must be a string");
    return value.getAsString();
  }

  private static boolean flag(JsonObject args, String name) {
    JsonElement value = args.get(name);
    if (value == null) return false;
    if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean())
      throw new IllegalArgumentException(name + " must be a boolean");
    return value.getAsBoolean();
  }

  private static int integer(JsonObject args, String name, int fallback) {
    JsonElement value = args.get(name);
    if (value == null) return fallback;
    if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber())
      throw new IllegalArgumentException(name + " must be a nonnegative integer");
    try {
      int result = value.getAsBigDecimal().intValueExact();
      if (result < 0) throw new ArithmeticException();
      return result;
    } catch (ArithmeticException error) {
      throw new IllegalArgumentException(name + " must be a nonnegative integer", error);
    }
  }

  private JadxSession session() {
    JadxSession current = holder.current();
    if (current == null) throw new IllegalArgumentException("No APK loaded");
    return current;
  }

  private void clearManifest() {
    manifestSession = null;
    manifestSnapshot = null;
  }

  /** Original archive identity, never a deobfuscated basename or name suffix. */
  private ManifestSnapshot manifest(JadxSession current) {
    if (manifestSession != current || manifestSnapshot == null) {
      ResourceFile selected = null;
      for (ResourceFile resource : current.getResources()) {
        if (resource.getType() != ResourceType.MANIFEST
            || !resource.getOriginalName().equals("AndroidManifest.xml")) continue;
        if (selected != null)
          throw new IllegalArgumentException("Root AndroidManifest.xml resource identity is ambiguous");
        selected = resource;
      }
      if (selected == null) throw new IllegalArgumentException("Root AndroidManifest.xml not found");
      var content = selected.loadContent();
      if (content == null || content.getDataType() != jadx.core.xmlgen.ResContainer.DataType.TEXT)
        throw new IllegalArgumentException("Root AndroidManifest.xml did not decode as text");
      String xml = content.getText().getCodeStr();
      ManifestSnapshot snapshot = new ManifestSnapshot(xml, manifestSummary(xml));
      manifestSnapshot = snapshot;
      manifestSession = current;
    }
    return manifestSnapshot;
  }

  /** One parsed XML owner supplies namespace-aware values alongside the exact decoded text. */
  static Map<String, Object> manifestSummary(String xml) {
    Element root;
    try {
      // Match REA's existing JDK XML setup: document types are unsupported.
      // Parse an in-memory string; XInclude and external DTD/schema I/O stay disabled.
      DocumentBuilderFactory factory = DocumentBuilderFactory.newDefaultNSInstance();
      factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
      factory.setXIncludeAware(false);
      factory.setAttribute(javax.xml.XMLConstants.ACCESS_EXTERNAL_DTD, "");
      factory.setAttribute(javax.xml.XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
      root = factory.newDocumentBuilder().parse(new InputSource(new StringReader(xml)))
          .getDocumentElement();
    } catch (javax.xml.parsers.ParserConfigurationException | org.xml.sax.SAXException
        | java.io.IOException failure) {
      throw new IllegalArgumentException("Root AndroidManifest.xml is not supported well-formed XML", failure);
    }
    if (!root.getTagName().equals("manifest") || root.getNamespaceURI() != null)
      throw new IllegalArgumentException("AndroidManifest.xml root must be an unnamespaced <manifest>");
    String android = "http://schemas.android.com/apk/res/android";
    String minSdk = "";
    String targetSdk = "";
    List<String> permissions = new ArrayList<>();
    for (Node child = root.getFirstChild(); child != null; child = child.getNextSibling()) {
      if (!(child instanceof Element element) || element.getNamespaceURI() != null) continue;
      if (element.getTagName().equals("uses-sdk")) {
        minSdk = element.getAttributeNS(android, "minSdkVersion");
        targetSdk = element.getAttributeNS(android, "targetSdkVersion");
      } else if (element.getTagName().equals("uses-permission")) {
        String permission = element.getAttributeNS(android, "name");
        if (!permission.isEmpty()) permissions.add(permission);
      }
    }
    Map<String, Object> summary = new LinkedHashMap<>();
    summary.put("package", root.getAttribute("package"));
    summary.put("version_name", root.getAttributeNS(android, "versionName"));
    summary.put("version_code", root.getAttributeNS(android, "versionCode"));
    summary.put("min_sdk", minSdk);
    summary.put("target_sdk", targetSdk);
    summary.put("permissions", List.copyOf(permissions));
    return Collections.unmodifiableMap(summary);
  }

  /** Snapshot every class identity once per session, before code generation can rewrite aliases. */
  private void ensureIndex(JadxSession current) {
    if (indexedSession != current) {
      Map<String, List<ClassSnapshot>> index = new LinkedHashMap<>();
      if (!current.getClasses().isEmpty()) {
        JadxDecompiler decompiler = current.getClasses().get(0).getClassNode().root().getDecompiler();
        // JavaClass.getMethods/getFields/getInnerClasses all load code. Raw nodes do not.
        // Snapshot every identity before code generation can rewrite aliases or members.
        for (JavaClass cls : decompiler.getClassesWithInners()) {
          ClassNode node = cls.getClassNode();
          List<MethodNode> ordered = new ArrayList<>(node.getMethods());
          ordered.sort(Comparator.comparing(MethodNode::getAlias));
          List<MethodSnapshot> methods = ordered.stream().map(method -> {
            String name = method.getAlias();
            String shortId = method.getMethodInfo().getShortId();
            String rawName = method.getMethodInfo().getName();
            if (!shortId.startsWith(rawName + "("))
              throw new IllegalStateException("JADX method ID has no raw-name prefix: " + shortId);
            String descriptor = shortId.substring(rawName.length());
            List<String> bodyAbsenceMarkers = new ArrayList<>();
            if (method.getAccessFlags().isNative()) bodyAbsenceMarkers.add("native_method");
            if (method.getAccessFlags().isAbstract()) bodyAbsenceMarkers.add("abstract_method");
            String signature = name + "(" + method.getArgTypes().stream()
                .map(Object::toString).collect(Collectors.joining(", "))
                + "): " + method.getReturnType().toString();
            return new MethodSnapshot(name, rawName, shortId, List.copyOf(bodyAbsenceMarkers), Map.of(
                "name", name, "signature", signature,
                "dex_descriptor", descriptor,
                "is_constructor", method.isConstructor(), "def_pos", 0));
          }).toList();
          List<FieldNode> orderedFields = new ArrayList<>(node.getFields());
          orderedFields.sort(Comparator.comparing(FieldNode::getAlias));
          List<Map<String, Object>> fields = new ArrayList<>();
          List<Map<String, Object>> valuedFields = new ArrayList<>();
          boolean anyValue = false;
          for (FieldNode field : orderedFields) {
            Map<String, Object> entry = Map.of("name", field.getAlias(),
                "type", field.getType().toString(), "def_pos", 0);
            fields.add(entry);
            Map<String, Object> value = dexStaticValue(field);
            if (value == null) valuedFields.add(entry);
            else {
              anyValue = true;
              Map<String, Object> valued = new LinkedHashMap<>(entry);
              valued.put("dex_static_value", value);
              valuedFields.add(Collections.unmodifiableMap(valued));
            }
          }
          List<String> inner = node.getInnerClasses().stream().map(ClassNode::getFullName).toList();
          Map<String, Object> summary = Map.of(
              "full_name", cls.getFullName(), "raw_name", cls.getRawName(), "name", cls.getName(),
              "method_count", methods.size(), "field_count", fields.size(),
              "inner_class_count", inner.size(), "inner_classes", inner,
              "methods", methods.stream().map(MethodSnapshot::summary).toList(), "fields", List.copyOf(fields));
          // DEX static values are opt-in, so method and reference lookups keep the member-only reply.
          Map<String, Object> summaryWithValues = summary;
          if (anyValue) {
            Map<String, Object> copy = new LinkedHashMap<>(summary);
            copy.put("fields", List.copyOf(valuedFields));
            summaryWithValues = Collections.unmodifiableMap(copy);
          }
          ClassSnapshot snapshot = new ClassSnapshot(cls, methods, summary, summaryWithValues);
          index.computeIfAbsent(cls.getFullName(), ignored -> new ArrayList<>()).add(snapshot);
          // Keep the binary identity supplied by JADX; '$' can also be a literal
          // name character, so replacing separators would invent lookup aliases.
          if (!cls.getRawName().equals(cls.getFullName()))
            index.computeIfAbsent(cls.getRawName(), ignored -> new ArrayList<>()).add(snapshot);
        }
      }
      classes = Collections.unmodifiableMap(index);
      indexedSession = current;
    }
  }

  private ClassSnapshot selected(JsonObject args) {
    ensureIndex(session());
    String name = string(args, "class_name");
    List<ClassSnapshot> candidates = classes.get(name);
    if (candidates == null) throw new InputFailure("class_name", "Exact class not found: " + name
        + "; use search_android_classes to discover fully qualified names.");
    if (candidates.size() != 1) throw new InputFailure("class_name", "Ambiguous metadata class identity: " + name
        + "; raw identities: " + candidates.stream().map(candidate -> candidate.node().getRawName()).toList());
    return candidates.get(0);
  }

  /** A static final field's class-definition static value; a static initializer can still assign it. */
  private static Map<String, Object> dexStaticValue(FieldNode field) {
    if (!field.getAccessFlags().isStatic() || !field.getAccessFlags().isFinal()) return null;
    EncodedValue encoded = field.get(JadxAttrType.CONSTANT_VALUE);
    if (encoded == null) return null;
    Object value = encoded.getValue();
    // JADX also attaches the shared null to static finals without a value, so null is never reported.
    // Wide and floating values keep their Java text instead of a lossy JSON number.
    return switch (encoded.getType()) {
      case ENCODED_BOOLEAN -> Map.of("type", "boolean", "value", value);
      case ENCODED_BYTE -> Map.of("type", "byte", "value", value);
      case ENCODED_SHORT -> Map.of("type", "short", "value", value);
      case ENCODED_CHAR -> Map.of("type", "char", "value", (int) (Character) value);
      case ENCODED_INT -> Map.of("type", "int", "value", value);
      case ENCODED_LONG -> Map.of("type", "long", "value", value.toString());
      case ENCODED_FLOAT -> Map.of("type", "float", "value", value.toString());
      case ENCODED_DOUBLE -> Map.of("type", "double", "value", value.toString());
      case ENCODED_STRING -> Map.of("type", "string", "value", value);
      default -> null;
    };
  }

  private List<MethodSnapshot> methods(ClassSnapshot cls, JsonObject args) {
    String name = string(args, "method_name");
    List<MethodSnapshot> result = cls.methods().stream().filter(method -> method.name().equals(name)).toList();
    if (result.isEmpty()) throw new InputFailure("method_name", "Method not found: " + name
        + "; use inspect_android_class to discover available methods.");
    return result;
  }

  private JavaMethod method(ClassSnapshot cls, MethodSnapshot selected) {
    JavaMethod result = cls.node().searchMethodByShortId(selected.shortId());
    if (result == null) throw new IllegalArgumentException("Method identity no longer available: " + selected.shortId());
    return result;
  }

  private JadxSession.SmartCode methodBody(JadxSession current, ClassSnapshot cls,
      MethodSnapshot selected, JavaMethod method) {
    // Access flags belong to the parsed member, before code generation rewrites it.
    // These methods have no Java body; source slicing can include unrelated members.
    if (!selected.bodyAbsenceMarkers().isEmpty())
      return new JadxSession.SmartCode("", "java", false, selected.bodyAbsenceMarkers());
    // Java code generation can fold all or part of <clinit> into field declarations.
    // Its method text cannot establish coverage, even when a static block remains.
    if (selected.shortId().equals("<clinit>()V"))
      return exactMethodSmali(current, cls, selected, List.of("static_initializer_disassembly"));
    String java = current.getMethodSource(method);
    if (java.startsWith("// ERROR:")) throw new IllegalArgumentException(java);
    // The upstream placeholder means only that Java code was omitted, including
    // methods merged into synthetic bridges. Access flags established absence above.
    if (java.isEmpty() || java.equals(
        "// method exists but has no decompiled body (native/abstract)"))
      return exactMethodSmali(current, cls, selected, List.of("java_body_unavailable"));
    List<String> markers = DecompileFailureKt.detectDecompileFailure(java);
    if (markers.stream().anyMatch(DecompileFailureKt.getSTRONG_FAILURE_MARKERS()::contains))
      return exactMethodSmali(current, cls, selected, markers);
    return new JadxSession.SmartCode(
        TextUtilKt.truncateToBytes(java, current.getMaxSourceBytes()), "java", false, markers);
  }

  private JadxSession.SmartCode exactMethodSmali(JadxSession current, ClassSnapshot cls,
      MethodSnapshot selected, List<String> markers) {
    JadxSession.MethodSmali smali = current.getMethodSmali(cls.node(), selected.rawName());
    String block = selectMethodSmali(smali, selected.shortId());
    return new JadxSession.SmartCode(
        TextUtilKt.truncateToBytes(block, current.getMaxSourceBytes()), "smali", true, markers);
  }

  private static String selectMethodSmali(JadxSession.MethodSmali smali, String shortId) {
    if (!smali.getFound())
      throw new IllegalArgumentException("JADX could not disassemble " + shortId
          + (smali.getNote() == null ? "" : ": " + smali.getNote()));
    // Upstream returns every same-name overload, and can return an unterminated
    // trailing block. Match the full original identity before applying output limits.
    List<String> matches = smali.getBlocks().stream().filter(block -> {
      String header = block.lines().findFirst().orElse("").strip();
      return header.startsWith(".method ") && header.endsWith(" " + shortId);
    }).toList();
    if (matches.size() != 1)
      throw new IllegalArgumentException("Disassembly could not establish one selected method: " + shortId);
    String block = matches.get(0);
    if (!block.stripTrailing().endsWith("\n.end method"))
      throw new IllegalArgumentException("Selected method disassembly is incomplete: " + shortId);
    return block;
  }

  // The local transport admits 8 MiB frames. Reserve 1 KiB for the fixed
  // JSON-RPC/CallToolResult envelope and generated numeric request id, and
  // account for JSON text being escaped again inside TextContent.
  private static final int MAX_XREF_TEXT_BYTES = 8 * 1024 * 1024 - 1024;
  // A resource scan reaches the client about four times over: raw_result keeps the
  // escaped reply, the normalized result repeats every site, and MCP sends both
  // structured content and text. 2 MiB keeps that frame under the 10 MiB default.
  private static final int MAX_RESOURCE_SCAN_BYTES = 2 * 1024 * 1024;
  private static int escapedJsonBytes(Object value) {
    return JSON.toJson(JSON.toJson(value)).getBytes(StandardCharsets.UTF_8).length;
  }
  private static final class InvokeBudget {
    long remaining;
    InvokeBudget(long remaining) { this.remaining = Math.max(0, remaining); }
    boolean admit(Map<String, Object> site) {
      // Check a conservative two-layer escape bound before serialization.
      long bound = 256;
      for (Object value : site.values())
        if (value instanceof String text) bound += 12L * text.length();
      if (bound > remaining) return false;
      long bytes = escapedJsonBytes(site) - 2L + 1L;
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    }
  }
  private record DirectInvokes(List<Map<String, Object>> sites, boolean exhaustive) {}

  /** Raw DEX invokes within one JADX using method; offsets are code units from its code start. */
  private static DirectInvokes directInvokes(JavaMethod source, MethodInfo target, InvokeBudget budget) {
    MethodNode node = source.getMethodNode();
    ICodeReader code = node.getCodeReader();
    if (code == null) return null;
    List<Map<String, Object>> sites = new ArrayList<>();
    boolean[] exhaustive = {true};
    code.visitInstructions(insn -> {
      insn.decode();
      if (insn.getIndexType() != InsnIndexType.METHOD_REF) return;
      Opcode opcode = insn.getOpcode();
      if (!opcode.name().startsWith("INVOKE_")) return;
      IMethodRef ref = insn.getIndexAsMethod();
      ref.load();
      if (!MethodInfo.fromRef(node.root(), ref).getRawFullId().equals(target.getRawFullId())) return;
      Map<String, Object> site = Map.of(
          "dex_entry", node.getInputFileName(),
          "source_raw_method_id", node.getMethodInfo().getRawFullId(),
          "dex_code_unit_offset", insn.getOffset(),
          "dex_method_index", insn.getIndex(),
          "opcode", opcode.name());
      if (budget.admit(site)) sites.add(site);
      else exhaustive[0] = false;
    });
    return new DirectInvokes(sites, exhaustive[0]);
  }

  private record ResourceRequest(String requested, String pkg, String type, String name,
      boolean framework, List<Integer> ids, boolean foreign) {}

  private static Map<String, List<Integer>> byName(Map<Integer, String> names) {
    Map<String, List<Integer>> result = new HashMap<>();
    for (Map.Entry<Integer, String> entry : names.entrySet())
      result.computeIfAbsent(entry.getValue(), ignored -> new ArrayList<>()).add(entry.getKey());
    result.values().forEach(Collections::sort);
    return result;
  }

  /**
   * Selectors come from the identity frozen before code generation, so they are the ones
   * inspect_android_method accepts. A class absent from that index cannot be inspected and
   * has no frozen identity; its live names are reported.
   */
  private static Map<String, Object> resourceSite(String kind, ClassNode cls, ClassSnapshot frozen,
      MethodNode method, int offset, Opcode opcode) {
    String className = cls.getFullName();
    String methodName = method.getAlias();
    int overloadIndex = 0;
    if (frozen != null) {
      className = String.valueOf(frozen.summary().get("full_name"));
      String shortId = method.getMethodInfo().getShortId();
      MethodSnapshot match = null;
      for (MethodSnapshot candidate : frozen.methods())
        if (candidate.shortId().equals(shortId)) { match = candidate; break; }
      if (match == null)
        throw new IllegalStateException("No frozen method identity for " + method.getMethodInfo().getRawFullId());
      methodName = match.name();
      for (MethodSnapshot candidate : frozen.methods()) {
        if (candidate == match) break;
        if (candidate.name().equals(methodName)) overloadIndex++;
      }
    } else {
      List<MethodNode> sameName = new ArrayList<>();
      for (MethodNode candidate : cls.getMethods())
        if (candidate.getAlias().equals(methodName)) sameName.add(candidate);
      overloadIndex = sameName.indexOf(method);
    }
    Map<String, Object> site = new LinkedHashMap<>();
    site.put("kind", kind);
    site.put("class_name", className);
    site.put("raw_class_name", cls.getRawName());
    site.put("top_class", cls.getTopParentClass().getFullName());
    site.put("method_name", methodName);
    site.put("overload_index", overloadIndex);
    site.put("raw_method_id", method.getMethodInfo().getRawFullId());
    site.put("dex_entry", method.getInputFileName());
    site.put("dex_code_unit_offset", offset);
    site.put("opcode", opcode.name());
    return site;
  }

  /**
   * Resolve resource names to integer IDs through the APK resource table, or JADX's bundled
   * framework map for the android package, then scan every method's raw DEX instructions once
   * for constant loads, switch keys, and R-field reads of those resources.
   */
  private CallToolResult resourceReferences(JsonObject args) {
    JadxSession current = session();
    JsonElement listed = args.get("resources");
    if (listed == null || !listed.isJsonArray() || listed.getAsJsonArray().isEmpty())
      throw new IllegalArgumentException("resources must be a non-empty array of strings");
    int maxSites = integer(args, "max_sites", 100);
    ensureIndex(current);
    Map<ClassNode, ClassSnapshot> frozenClasses = new IdentityHashMap<>();
    for (List<ClassSnapshot> snapshots : classes.values())
      for (ClassSnapshot snapshot : snapshots) frozenClasses.put(snapshot.node().getClassNode(), snapshot);
    RootNode root = current.getClasses().isEmpty() ? null
        : current.getClasses().get(0).getClassNode().root();
    Map<String, List<Integer>> app = root == null ? Map.of()
        : byName(root.getConstValues().getResourcesNames());
    Map<String, List<Integer>> framework = byName(AndroidResourcesMap.getMap());
    String appPackage = root == null ? null : root.getAppPackage();
    List<ResourceRequest> requests = new ArrayList<>();
    for (JsonElement element : listed.getAsJsonArray()) {
      if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString())
        throw new IllegalArgumentException("resources must contain strings");
      String requested = element.getAsString();
      int colon = requested.indexOf(':');
      String pkg = colon < 0 ? null : requested.substring(0, colon);
      String rest = colon < 0 ? requested : requested.substring(colon + 1);
      int slash = rest.indexOf('/');
      if (slash <= 0 || slash == rest.length() - 1)
        throw new IllegalArgumentException("Resource must be [package:]type/name: " + requested);
      String type = rest.substring(0, slash);
      String name = rest.substring(slash + 1);
      boolean isFramework = "android".equals(pkg);
      // A qualifier naming another app is unresolved here: its ids and R fields are not this APK's.
      boolean foreign = pkg != null && !isFramework && !pkg.equals(appPackage);
      List<Integer> ids = foreign ? List.of()
          : (isFramework ? framework : app).getOrDefault(type + "/" + name, List.of());
      requests.add(new ResourceRequest(requested, pkg, type, name, isFramework, ids, foreign));
    }
    Map<Long, List<Integer>> literals = new HashMap<>();
    Map<String, List<Integer>> fieldReads = new HashMap<>();
    List<List<Map<String, Object>>> sites = new ArrayList<>();
    List<List<Map<String, Object>>> declarations = new ArrayList<>();
    int[] totals = new int[requests.size()];
    int[] fieldTotals = new int[requests.size()];
    for (int index = 0; index < requests.size(); index++) {
      ResourceRequest request = requests.get(index);
      for (int id : request.ids())
        literals.computeIfAbsent((long) id, ignored -> new ArrayList<>()).add(index);
      if (!request.foreign())
        fieldReads.computeIfAbsent(request.type() + "/" + request.name(), ignored -> new ArrayList<>())
            .add(index);
      sites.add(new ArrayList<>());
      declarations.add(new ArrayList<>());
    }
    int[] scanned = {0};
    // getClasses(true) is the full list: inner and anonymous classes (click handlers) included.
    List<ClassNode> classNodes = root == null ? List.of() : root.getClasses(true);
    // Sites and declarations share the transport budget left after the fixed
    // response; matches past it are still counted so coverage stays partial.
    InvokeBudget budget = new InvokeBudget(MAX_RESOURCE_SCAN_BYTES
        - escapedJsonBytes(resourceResponse(requests, maxSites, Integer.MAX_VALUE,
            Integer.MAX_VALUE, Integer.MAX_VALUE, null, null, null, null)));
    for (ClassNode cls : classNodes) {
      String rawName = cls.getRawName();
      int marker = rawName.lastIndexOf(".R$");
      if (marker >= 0) {
        String type = rawName.substring(marker + 3);
        boolean frameworkClass = rawName.equals("android.R$" + type);
        for (FieldNode field : cls.getFields()) {
          String fieldName = field.getFieldInfo().getName();
          List<Integer> matches = fieldReads.get(type + "/" + fieldName);
          if (matches == null) continue;
          for (int index : matches) {
            if (requests.get(index).framework() != frameworkClass) continue;
            fieldTotals[index]++;
            Map<String, Object> declaration = Map.of("class_name", rawName, "field_name", fieldName,
                // JADX synthesizes an app R class from the resource table when the APK lacks one.
                "origin", cls.getClsData() == null ? "jadx_generated" : "dex");
            if (budget.admit(declaration)) declarations.get(index).add(declaration);
          }
        }
      }
      for (MethodNode method : cls.getMethods()) {
        ICodeReader code = method.getCodeReader();
        if (code == null) continue;
        scanned[0]++;
        code.visitInstructions(insn -> {
          insn.decode();
          Opcode opcode = insn.getOpcode();
          Set<Integer> matched = new LinkedHashSet<>();
          String kind = null;
          if (opcode == Opcode.CONST || opcode == Opcode.CONST_WIDE) {
            List<Integer> hit = literals.get(insn.getLiteral());
            if (hit != null) matched.addAll(hit);
            kind = "const_literal";
          } else if (opcode == Opcode.PACKED_SWITCH_PAYLOAD || opcode == Opcode.SPARSE_SWITCH_PAYLOAD) {
            if (insn.getPayload() instanceof ISwitchPayload payload)
              for (int key : payload.getKeys()) {
                List<Integer> hit = literals.get((long) key);
                if (hit != null) matched.addAll(hit);
              }
            kind = "switch_case";
          } else if (insn.getIndexType() == InsnIndexType.FIELD_REF && opcode.name().startsWith("SGET")) {
            IFieldRef field = insn.getIndexAsField();
            String parent = field.getParentClassType();
            int rMarker = parent.lastIndexOf("/R$");
            if (rMarker >= 0 && parent.endsWith(";")) {
              String type = parent.substring(rMarker + 3, parent.length() - 1);
              boolean frameworkParent = parent.equals("Landroid/R$" + type + ";");
              List<Integer> hit = fieldReads.get(type + "/" + field.getName());
              if (hit != null)
                for (int index : hit)
                  if (requests.get(index).framework() == frameworkParent) matched.add(index);
              kind = "r_field_read";
            }
          }
          for (int index : matched) {
            totals[index]++;
            if (sites.get(index).size() >= maxSites) continue;
            Map<String, Object> site = resourceSite(kind, cls, frozenClasses.get(cls), method, insn.getOffset(), opcode);
            if (budget.admit(site)) sites.get(index).add(site);
          }
        });
      }
    }
    return json(resourceResponse(requests, maxSites, classNodes.size(), scanned[0], app.size(),
        totals, fieldTotals, sites, declarations));
  }

  /** Response shape; null lists produce the empty, maximal-count skeleton used for budgeting. */
  private static Map<String, Object> resourceResponse(List<ResourceRequest> requests, int maxSites,
      int classes, int methods, int appNames, int[] totals, int[] fieldTotals,
      List<List<Map<String, Object>>> sites, List<List<Map<String, Object>>> declarations) {
    List<Map<String, Object>> results = new ArrayList<>();
    for (int index = 0; index < requests.size(); index++) {
      ResourceRequest request = requests.get(index);
      Map<String, Object> result = new LinkedHashMap<>();
      result.put("requested", request.requested());
      result.put("package", request.pkg() == null ? "" : request.pkg());
      result.put("type", request.type());
      result.put("name", request.name());
      result.put("table", request.framework() ? "framework" : "app");
      result.put("ids", request.ids());
      result.put("total_r_fields", fieldTotals == null ? Integer.MAX_VALUE : fieldTotals[index]);
      result.put("r_fields", declarations == null ? List.of() : declarations.get(index));
      result.put("total_sites", totals == null ? Integer.MAX_VALUE : totals[index]);
      result.put("sites", sites == null ? List.of() : sites.get(index));
      results.add(result);
    }
    Map<String, Object> response = new LinkedHashMap<>();
    response.put("classes_scanned", classes);
    response.put("methods_scanned", methods);
    response.put("app_resource_names", appNames);
    response.put("max_sites", maxSites);
    response.put("resources", results);
    return response;
  }

  private CallToolResult handle(String name, kotlinx.serialization.json.JsonObject input) {
    JsonObject args = JsonParser.parseString(input.toString()).getAsJsonObject();
    if (name.equals("rea_jvm_status")) return json(Map.of(
        "engine_reported_version", BuildInfo.VERSION,
        "max_heap_bytes", Runtime.getRuntime().maxMemory(),
        "available_processors", Runtime.getRuntime().availableProcessors(),
        "java_version", System.getProperty("java.version"),
        "metadata_scope", "parsed_members"));
    if (name.equals("rea_resource_references")) return resourceReferences(args);
    JadxSession current = session();
    if (name.equals("get_app_info")) return json(manifest(current).summary());
    if (name.equals("get_android_manifest"))
      return text(TextUtilKt.truncateToBytes(manifest(current).text(), current.getMaxSourceBytes()), false);
    if (name.equals("list_classes")) {
      List<String> names = current.getClassFqns();
      String query = args.has("query") ? string(args, "query") : "";
      int offset = integer(args, "offset", 0);
      int limit = integer(args, "limit", 200);
      int start = Math.min(offset, names.size());
      int end = start;
      List<String> items;
      if (query.isEmpty()) {
        end = (int) Math.min((long) start + limit, names.size());
        items = names.subList(start, end);
      } else {
        items = new ArrayList<>();
        while (end < names.size() && items.size() < limit) {
          String nameInInventory = names.get(end++);
          if (nameInInventory.contains(query)) items.add(nameInInventory);
        }
      }
      return json(Map.of("total_classes", names.size(), "next_offset", end,
          "scope", "top_level", "offset", offset, "limit", limit,
          "items", items));
    }
    ClassSnapshot cls = selected(args);
    if (name.equals("get_class_summary"))
      return json(flag(args, "dex_static_values") ? cls.summaryWithValues() : cls.summary());
    if (name.equals("get_method_body")) {
      List<MethodSnapshot> overloads = methods(cls, args);
      int index = integer(args, "overload_index", 0);
      if (index >= overloads.size()) throw new InputFailure("overload_index", "overload_index out of range: " + index);
      JavaMethod method = method(cls, overloads.get(index));
      JadxSession.SmartCode code = methodBody(current, cls, overloads.get(index), method);
      return json(Map.of("class_name", cls.summary().get("full_name"),
          "method_name", overloads.get(index).name(), "full_name", method.getFullName(),
          "dex_descriptor", overloads.get(index).summary().get("dex_descriptor"),
          "overload_index", index, "overload_count", overloads.size(),
          "mode", code.getKind(), "fell_back", code.getFellBack(),
          "markers", code.getMarkers(), "body", code.getText()));
    }
    List<JavaNode> uses;
    String target = (String) cls.summary().get("full_name");
    MethodSnapshot selectedMethod = null;
    int overloadIndex = 0;
    if (name.equals("get_xrefs_to_class")) uses = cls.node().getUseIn();
    else {
      List<MethodSnapshot> overloads = methods(cls, args);
      if (overloads.size() != 1 && !args.has("overload_index"))
        throw new InputFailure("overload_index", "Select one of " + overloads.size() + " method overloads");
      overloadIndex = integer(args, "overload_index", 0);
      if (overloadIndex >= overloads.size())
        throw new InputFailure("overload_index", "overload_index out of range: " + overloadIndex);
      selectedMethod = overloads.get(overloadIndex);
      target += "." + selectedMethod.name();
      uses = method(cls, selectedMethod).getUseIn();
    }
    // REA consumes all references without materializing source line information.
    MethodInfo targetInfo = selectedMethod == null ? null : method(cls, selectedMethod).getMethodNode().getMethodInfo();
    List<Map<String, Object>> items = uses.stream().map(node -> {
      Map<String, Object> item = new LinkedHashMap<>(current.describeUsage(node, false));
      if (targetInfo != null && node instanceof JavaMethod) {
        item.put("direct_invokes", List.of());
        item.put("direct_invokes_exhaustive", false);
      }
      return item;
    }).toList();
    Map<String, Object> result = new LinkedHashMap<>(Map.of("target", target,
        "total", uses.size(), "count", items.size(), "resolve_line", false, "items", items));
    if (selectedMethod != null) {
      result.put("overload_index", overloadIndex);
      result.put("reported_signature", selectedMethod.summary().get("signature"));
    }
    if (targetInfo != null) {
      InvokeBudget budget = new InvokeBudget(MAX_XREF_TEXT_BYTES - escapedJsonBytes(result));
      for (int index = 0; index < uses.size(); index++) {
        if (!(uses.get(index) instanceof JavaMethod source)) continue;
        DirectInvokes invokes = directInvokes(source, targetInfo, budget);
        Map<String, Object> item = items.get(index);
        if (invokes == null) {
          item.remove("direct_invokes");
          item.remove("direct_invokes_exhaustive");
        } else {
          item.put("direct_invokes", invokes.sites());
          item.put("direct_invokes_exhaustive", invokes.exhaustive());
        }
      }
    }
    return json(result);
  }

  private static void registerBridgeTool(Server server, ReaJadxBridge bridge, String name,
      ToolSchema schema, String description) {
    Tool tool = new Tool(name, schema, description, null, null, null, null, null, null);
    server.addTool(tool, (connection, request, continuation) -> {
      try { return bridge.handle(name, request.getArguments()); }
      catch (InputFailure error) { return text(JSON.toJson(Map.of(
          "kind", "invalid-input", "field", error.field, "message", error.getMessage())), true); }
      catch (IllegalArgumentException error) { return text(error.getMessage(), true); }
    });
  }

  public static void main(String[] args) throws Exception {
    PrintStream protocolOut = System.out;
    System.setOut(System.err);
    SessionConfig defaults = new SessionConfig(
        1048576, 0, 90000L, 1, List.of(), List.of(), 64, ResourceMode.FULL);
    SessionHolder holder = new SessionHolder(defaults);
    ServerCapabilities capabilities = new ServerCapabilities(
        new ServerCapabilities.Tools(null), null, null, null, null, null, null, Map.of());
    Server server = new Server(new Implementation("rea-jadx-bridge", "7", null, null, null),
        new ServerOptions(capabilities), "", ignored -> Unit.INSTANCE);
    SessionToolsKt.registerSessionTools(server, holder);
    ClassToolsKt.registerClassTools(server, holder);
    MethodToolsKt.registerMethodTools(server, holder);
    XrefToolsKt.registerXrefTools(server, holder);
    ReaJadxBridge bridge = new ReaJadxBridge(holder);
    Tool loadTool = server.getTools().get("load_apk").getTool();
    server.removeTool("load_apk");
    server.addTool(loadTool, (connection, request, continuation) ->
        bridge.load(request.getArguments(), defaults, continuation));
    Set<String> consumed = Set.of("load_apk",
        "list_classes", "get_class_summary", "get_method_body",
        "get_xrefs_to_class", "get_xrefs_to_method");
    for (String name : new ArrayList<>(server.getTools().keySet()))
      if (!consumed.contains(name)) server.removeTool(name);
    Tool diagnostics = new Tool("rea_jvm_status",
        new ToolSchema(null, new kotlinx.serialization.json.JsonObject(Map.of()), List.of(), null),
        "Observed worker JVM and metadata scope", null, null, null, null, null, null);
    server.addTool(diagnostics, (connection, request, continuation) -> bridge.handle("rea_jvm_status", request.getArguments()));
    for (String name : List.of("get_app_info", "get_android_manifest")) {
      String description = name.equals("get_app_info")
          ? "Namespace-aware summary of the exact root AndroidManifest.xml resource."
          : "Exact decoded root AndroidManifest.xml text, bounded by the session source byte limit.";
      registerBridgeTool(server, bridge, name,
          new ToolSchema(null, new kotlinx.serialization.json.JsonObject(Map.of()), List.of(), null), description);
    }
    Map<String, kotlinx.serialization.json.JsonElement> resourceProperties = new LinkedHashMap<>();
    resourceProperties.put("resources", new kotlinx.serialization.json.JsonObject(Map.of(
        "type", kotlinx.serialization.json.JsonElementKt.JsonPrimitive("array"),
        "items", new kotlinx.serialization.json.JsonObject(Map.of(
            "type", kotlinx.serialization.json.JsonElementKt.JsonPrimitive("string"))))));
    resourceProperties.put("max_sites", new kotlinx.serialization.json.JsonObject(Map.of(
        "type", kotlinx.serialization.json.JsonElementKt.JsonPrimitive("integer"))));
    Tool resources = new Tool("rea_resource_references",
        new ToolSchema(null, new kotlinx.serialization.json.JsonObject(resourceProperties),
            List.of("resources"), null),
        "Resolve [package:]type/name resources to IDs and list raw DEX constant, switch, and R-field uses",
        null, null, null, null, null, null);
    server.addTool(resources, (connection, request, continuation) -> {
      try { return bridge.handle("rea_resource_references", request.getArguments()); }
      catch (IllegalArgumentException error) { return text(error.getMessage(), true); }
    });
    for (String name : List.of("list_classes", "get_class_summary",
        "get_method_body", "get_xrefs_to_class", "get_xrefs_to_method")) {
      Tool tool = server.getTools().get(name).getTool();
      server.removeTool(name);
      List<String> fields = switch (name) {
        case "list_classes" -> List.of("offset", "limit");
        case "get_method_body" -> List.of("class_name", "method_name", "overload_index");
        case "get_xrefs_to_method" -> List.of("class_name", "method_name", "overload_index");
        default -> List.of("class_name");
      };
      Map<String, kotlinx.serialization.json.JsonElement> properties = new LinkedHashMap<>();
      for (String field : fields) properties.put(field, tool.getInputSchema().getProperties().get(field));
      if (name.equals("list_classes")) properties.put("query",
          new kotlinx.serialization.json.JsonObject(Map.of(
              "type", kotlinx.serialization.json.JsonElementKt.JsonPrimitive("string"))));
      if (name.equals("get_class_summary")) properties.put("dex_static_values",
          new kotlinx.serialization.json.JsonObject(Map.of(
              "type", kotlinx.serialization.json.JsonElementKt.JsonPrimitive("boolean"))));
      String description = switch (name) {
        case "list_classes" -> "Pages of case-sensitive matching top-level class names; offset and next_offset are inventory positions, limit bounds matching rows. Omitted or empty query inventories all names.";
        case "get_class_summary" -> "Parsed member metadata for one exact class name; no source generation. Set dex_static_values to include encoded static final field values.";
        case "get_method_body" -> "Source for an exact class and stable same-name overload index; static initializers use smali to preserve folded field initialization.";
        default -> "Complete static using-node inventory for an exact class or selected method overload; one node may contain multiple invoke instructions, and source lines are unresolved.";
      };
      registerBridgeTool(server, bridge, name,
          new ToolSchema(null, new kotlinx.serialization.json.JsonObject(properties),
              tool.getInputSchema().getRequired(), null), description);
    }
    CountDownLatch done = new CountDownLatch(1);
    server.onClose(() -> { done.countDown(); return Unit.INSTANCE; });
    StdioServerTransport transport = new StdioServerTransport(
        CoreKt.buffered(JvmCoreKt.asSource(System.in)),
        CoreKt.buffered(JvmCoreKt.asSink(protocolOut)));
    transport.onClose(() -> { done.countDown(); return Unit.INSTANCE; });
    ServerSession connection = null;
    try {
      connection = BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> server.createSession(transport, continuation));
      done.await();
    } finally {
      try {
        if (connection != null) {
          ServerSession connected = connection;
          // Unsubscribe the connection before the SDK joins its notification service.
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> connected.close(continuation));
        }
      } finally {
        try {
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> server.close(continuation));
        } finally {
          bridge.clearManifest();
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> holder.unload(continuation));
        }
      }
    }
  }
}
