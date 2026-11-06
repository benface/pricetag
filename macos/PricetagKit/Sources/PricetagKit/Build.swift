/// What kind of build this is. `macos/watch-only.sh` is the only thing that sets it.
public enum Build {
    /// Has no key code in it, and shows nothing that needs one.
    public static let isWatchOnly: Bool = {
        #if PATINA_WATCH_ONLY
        true
        #else
        false
        #endif
    }()
}
