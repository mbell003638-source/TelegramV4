package com.agentos.client

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.agentos.client.data.AppGraph
import com.agentos.client.ui.agents.AgentsScreen
import com.agentos.client.ui.agents.AgentsViewModel
import com.agentos.client.ui.chat.ChatScreen
import com.agentos.client.ui.chat.ChatViewModel
import com.agentos.client.ui.connect.ConnectScreen
import com.agentos.client.ui.connect.ConnectViewModel
import com.agentos.client.ui.memory.MemoryScreen
import com.agentos.client.ui.memory.MemoryViewModel
import com.agentos.client.ui.remote.RemoteScreen
import com.agentos.client.ui.remote.RemoteViewModel
import com.agentos.client.ui.theme.AgentOsTheme
import com.agentos.client.ui.theme.AmoledBlack
import com.agentos.client.ui.theme.SurfaceRaised
import com.agentos.client.ui.theme.TextMuted

/**
 * The single Activity. Declared in AndroidManifest.xml as `.MainActivity`
 * against namespace `com.agentos.client`, i.e. exactly this class.
 *
 * There is no navigation library in app/build.gradle.kts and this app does not
 * need one: five sibling tabs with no back stack between them is a `when`.
 * Each screen's ViewModel is resolved against THIS Activity's ViewModelStore,
 * so switching tabs never discards loaded data or re-fires a request — and the
 * Chat tab's SSE subscription keeps running while you are on another tab.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Must happen before the first composition: every ViewModel below is
        // built by AppGraph.viewModelFactory, which needs the repository.
        AppGraph.init(applicationContext)

        setContent {
            AgentOsTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = AmoledBlack,
                ) {
                    AgentOsApp()
                }
            }
        }
    }
}

/** The five tabs, in bar order. */
private enum class Tab(val label: String, val glyph: String) {
    Connect("Connect", "🔌"),
    Agents("Agents", "🤖"),
    Chat("Chat", "💬"),
    Remote("Remote", "🎮"),
    Memory("Memory", "🧠"),
}

@Composable
private fun AgentOsApp() {
    // Survives rotation and process death; `configChanges` in the manifest
    // already absorbs rotation, but this costs nothing.
    var selected by rememberSaveable { mutableStateOf(Tab.Connect.name) }
    val current = runCatching { Tab.valueOf(selected) }.getOrDefault(Tab.Connect)

    Scaffold(
        containerColor = AmoledBlack,
        bottomBar = {
            NavigationBar(containerColor = SurfaceRaised) {
                for (tab in Tab.values()) {
                    NavigationBarItem(
                        selected = tab == current,
                        onClick = { selected = tab.name },
                        icon = { Text(text = tab.glyph, fontSize = 17.sp) },
                        label = {
                            Text(
                                text = tab.label,
                                fontSize = 11.sp,
                                fontWeight = if (tab == current) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        },
                        colors = NavigationBarItemDefaults.colors(
                            selectedTextColor = MaterialTheme.colorScheme.primary,
                            unselectedTextColor = TextMuted,
                            indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                        ),
                    )
                }
            }
        },
    ) { innerPadding ->
        Column(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            when (current) {
                Tab.Connect -> {
                    val vm: ConnectViewModel = viewModel(factory = AppGraph.viewModelFactory)
                    ConnectScreen(viewModel = vm)
                }

                Tab.Agents -> {
                    val vm: AgentsViewModel = viewModel(factory = AppGraph.viewModelFactory)
                    AgentsScreen(viewModel = vm)
                }

                Tab.Chat -> {
                    val vm: ChatViewModel = viewModel(factory = AppGraph.viewModelFactory)
                    ChatScreen(viewModel = vm)
                }

                Tab.Remote -> {
                    val vm: RemoteViewModel = viewModel(factory = AppGraph.viewModelFactory)
                    RemoteScreen(viewModel = vm)
                }

                Tab.Memory -> {
                    val vm: MemoryViewModel = viewModel(factory = AppGraph.viewModelFactory)
                    MemoryScreen(viewModel = vm)
                }
            }
        }
    }
}
