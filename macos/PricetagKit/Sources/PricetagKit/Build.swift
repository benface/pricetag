/// What kind of build this is. `macos/watch-only.sh` and `macos/hosted.sh` are the only things that set it.
public enum Build {
    /// Has no key code in it, and shows nothing that needs one.
    public static let isWatchOnly: Bool = {
        #if PATINA_WATCH_ONLY
        true
        #else
        false
        #endif
    }()

    /// Goes to other people, and reads the server it was built for, so it asks for an invite and has no Server tab.
    public static let isForOtherPeople: Bool = {
        #if PATINA_WATCH_ONLY || PATINA_HOSTED
        true
        #else
        false
        #endif
    }()
}
